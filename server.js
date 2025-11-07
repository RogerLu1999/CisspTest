const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const crypto = require('crypto');

const BASE_DIR = __dirname;
const DATA_DIR = path.join(BASE_DIR, 'data');
const QUESTIONS_FILE = path.join(DATA_DIR, 'questions.json');
const WRONG_FILE = path.join(DATA_DIR, 'wrong_questions.json');
const QUESTION_BANK_VERSION = 2;
const HOST = process.env.HOST || '0.0.0.0';
const PORT = process.env.PORT ? Number(process.env.PORT) : 8000;

const QWEN_API_URL =
  process.env.QWEN_API_URL || 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation';
const QWEN_MODEL = process.env.QWEN_MODEL || 'qwen-turbo';
const QWEN_API_KEY = process.env.DASHSCOPE_API_KEY || '';

const DNS_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

const DOMAIN_OPTIONS = [
  'Security and Risk Management',
  'Asset Security',
  'Security Architecture and Engineering',
  'Communication and Network Security',
  'Identity and Access Management (IAM)',
  'Security Assessment and Testing',
  'Security Operations',
  'Software Development Security',
];

const sessions = new Map();

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return [];
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) {
      return [];
    }
    return JSON.parse(raw);
  } catch (error) {
    return [];
  }
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function uuidToBytes(uuid) {
  const hex = uuid.replace(/-/g, '');
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.slice(i, i + 2), 16));
  }
  return Buffer.from(bytes);
}

function bytesToUuid(bytes) {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

function uuidv5(name, namespace) {
  const nsBytes = uuidToBytes(namespace);
  const hash = crypto.createHash('sha1');
  hash.update(nsBytes);
  hash.update(Buffer.from(String(name), 'utf8'));
  const digest = hash.digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  return bytesToUuid(digest.slice(0, 16));
}

function normalizeCorrectAnswers(rawAnswers, choices) {
  if (rawAnswers === undefined || rawAnswers === null) {
    return [];
  }
  const answers = Array.isArray(rawAnswers) ? rawAnswers : [rawAnswers];
  const normalized = new Set();
  const lowerChoices = choices.map((choice) => choice.toLowerCase());
  for (const answer of answers) {
    if (typeof answer === 'number' && Number.isInteger(answer)) {
      if (answer >= 0 && answer < choices.length) {
        normalized.add(answer);
      }
      continue;
    }
    if (typeof answer === 'string') {
      const trimmed = answer.trim();
      if (!trimmed) {
        continue;
      }
      if (/^[A-Za-z]$/.test(trimmed)) {
        const idx = trimmed.toUpperCase().charCodeAt(0) - 65;
        if (idx >= 0 && idx < choices.length) {
          normalized.add(idx);
          continue;
        }
      }
      const lowered = trimmed.toLowerCase();
      const matchIndex = lowerChoices.indexOf(lowered);
      if (matchIndex !== -1) {
        normalized.add(matchIndex);
      }
    }
  }
  return Array.from(normalized).sort((a, b) => a - b);
}

function normalizeQuestion(rawQuestion) {
  if (!rawQuestion || typeof rawQuestion !== 'object') {
    throw new Error('Question must be an object');
  }
  const questionText = (rawQuestion.question || rawQuestion.text || rawQuestion.prompt || '').toString().trim();
  if (!questionText) {
    throw new Error('Question text is required');
  }
  let rawChoices = rawQuestion.choices || rawQuestion.options;
  if (rawChoices && typeof rawChoices === 'object' && !Array.isArray(rawChoices)) {
    rawChoices = Object.keys(rawChoices)
      .sort()
      .map((key) => rawChoices[key]);
  }
  if (!Array.isArray(rawChoices) || rawChoices.length < 2) {
    throw new Error('Choices must be a list with at least two options');
  }
  const choices = rawChoices.map((choice) => choice.toString());
  const correctAnswers = normalizeCorrectAnswers(
    rawQuestion.correct_answers || rawQuestion.correct_answer || rawQuestion.answer || rawQuestion.answers,
    choices,
  );
  if (!correctAnswers.length) {
    throw new Error('At least one correct answer is required');
  }
  const domainRaw = rawQuestion.domain !== undefined && rawQuestion.domain !== null ? rawQuestion.domain : 'General';
  const domain = domainRaw.toString().trim() || 'General';
  const commentRaw = rawQuestion.comment || rawQuestion.explanation || '';
  const comment = commentRaw !== undefined && commentRaw !== null ? commentRaw.toString().trim() : '';
  const providedId = rawQuestion.id || rawQuestion.uuid;
  let questionId = providedId ? String(providedId) : null;
  if (!questionId) {
    const namespace = uuidv5(questionText, DNS_NAMESPACE);
    questionId = uuidv5('cissp-question', namespace);
  }
  return {
    id: questionId,
    question: questionText,
    choices,
    correct_answers: correctAnswers,
    domain,
    comment,
  };
}

function normalizeExplanation(rawValue) {
  if (rawValue === undefined || rawValue === null) {
    return '';
  }
  return rawValue.toString().trim();
}

function buildGroupFromLegacyQuestion(question) {
  if (!question || typeof question !== 'object') {
    return null;
  }
  const normalized = {
    id: question.id ? String(question.id) : uuidv5(String(question.question || crypto.randomUUID()), DNS_NAMESPACE),
    question: String(question.question || ''),
    choices: Array.isArray(question.choices) ? question.choices.map((choice) => choice.toString()) : [],
    correct_answers: Array.isArray(question.correct_answers)
      ? question.correct_answers.map((value) => Number.parseInt(value, 10)).filter((value) => Number.isInteger(value))
      : normalizeCorrectAnswers(question.correct_answers, Array.isArray(question.choices) ? question.choices : []),
    explanation: normalizeExplanation(question.comment || question.explanation),
  };
  if (!normalized.question || normalized.choices.length < 2 || !normalized.correct_answers.length) {
    return null;
  }
  const groupIdSource = question.group_id || question.groupId || `group-${normalized.id}`;
  return {
    id: String(groupIdSource),
    domain: (question.domain || 'General').toString().trim() || 'General',
    context: normalizeExplanation(question.context),
    questions: [normalized],
  };
}

function sanitizeGroup(rawGroup) {
  if (!rawGroup || typeof rawGroup !== 'object') {
    return null;
  }
  const domain = (rawGroup.domain || 'General').toString().trim() || 'General';
  const context = normalizeExplanation(rawGroup.context);
  const groupId = rawGroup.id ? String(rawGroup.id) : crypto.randomUUID();
  const questions = Array.isArray(rawGroup.questions) ? rawGroup.questions : [];
  const sanitizedQuestions = [];
  for (const rawQuestion of questions) {
    if (!rawQuestion || typeof rawQuestion !== 'object') {
      continue;
    }
    const text = rawQuestion.question || rawQuestion.prompt || rawQuestion.text || '';
    const questionText = text.toString().trim();
    if (!questionText) {
      continue;
    }
    let rawChoices = rawQuestion.choices || rawQuestion.options;
    if (rawChoices && typeof rawChoices === 'object' && !Array.isArray(rawChoices)) {
      rawChoices = Object.keys(rawChoices)
        .sort()
        .map((key) => rawChoices[key]);
    }
    if (!Array.isArray(rawChoices) || rawChoices.length < 2) {
      continue;
    }
    const choices = rawChoices.map((choice) => choice.toString());
    const correctAnswers = Array.isArray(rawQuestion.correct_answers)
      ? rawQuestion.correct_answers
          .map((value) => Number.parseInt(value, 10))
          .filter((value) => Number.isInteger(value) && value >= 0 && value < choices.length)
      : normalizeCorrectAnswers(
          rawQuestion.correct_answers || rawQuestion.correct_answer || rawQuestion.answers,
          choices,
        );
    if (!correctAnswers.length) {
      continue;
    }
    const explanation = normalizeExplanation(rawQuestion.comment || rawQuestion.explanation);
    const questionId = rawQuestion.id
      ? String(rawQuestion.id)
      : uuidv5(`${groupId}::${questionText}`, DNS_NAMESPACE);
    sanitizedQuestions.push({
      id: questionId,
      question: questionText,
      choices,
      correct_answers: Array.from(new Set(correctAnswers)).sort((a, b) => a - b),
      explanation,
    });
  }
  if (!sanitizedQuestions.length) {
    return null;
  }
  return {
    id: groupId,
    domain,
    context,
    questions: sanitizedQuestions,
  };
}

function loadQuestionBank() {
  const raw = readJson(QUESTIONS_FILE);
  if (Array.isArray(raw)) {
    const groups = [];
    for (const item of raw) {
      const group = buildGroupFromLegacyQuestion(item);
      if (group) {
        groups.push(group);
      }
    }
    return { version: QUESTION_BANK_VERSION, groups };
  }
  if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.groups)) {
      const groups = raw.groups
        .map((group) => sanitizeGroup(group))
        .filter((group) => group !== null);
      return { version: QUESTION_BANK_VERSION, groups };
    }
    if (Array.isArray(raw.questions)) {
      const groups = [];
      for (const item of raw.questions) {
        const group = buildGroupFromLegacyQuestion(item);
        if (group) {
          groups.push(group);
        }
      }
      return { version: QUESTION_BANK_VERSION, groups };
    }
  }
  return { version: QUESTION_BANK_VERSION, groups: [] };
}

function saveQuestionBank(bank) {
  if (!bank || typeof bank !== 'object') {
    writeJson(QUESTIONS_FILE, { version: QUESTION_BANK_VERSION, groups: [] });
    return;
  }
  const groups = Array.isArray(bank.groups) ? bank.groups : [];
  const sanitized = groups
    .map((group) => sanitizeGroup(group))
    .filter((group) => group !== null);
  writeJson(QUESTIONS_FILE, { version: QUESTION_BANK_VERSION, groups: sanitized });
}

function flattenQuestionBank(bank) {
  const result = [];
  if (!bank || !Array.isArray(bank.groups)) {
    return result;
  }
  for (const group of bank.groups) {
    if (!group || typeof group !== 'object') {
      continue;
    }
    const domain = (group.domain || 'General').toString().trim() || 'General';
    const context = normalizeExplanation(group.context);
    const questions = Array.isArray(group.questions) ? group.questions : [];
    for (const question of questions) {
      if (!question || typeof question !== 'object') {
        continue;
      }
      const text = (question.question || question.prompt || question.text || '').toString().trim();
      if (!text) {
        continue;
      }
      const rawChoices = Array.isArray(question.choices) ? question.choices : [];
      const choices = rawChoices.map((choice) => choice.toString());
      if (choices.length < 2) {
        continue;
      }
      const correctAnswers = Array.isArray(question.correct_answers)
        ? question.correct_answers
            .map((value) => Number.parseInt(value, 10))
            .filter((value) => Number.isInteger(value) && value >= 0 && value < choices.length)
        : normalizeCorrectAnswers(question.correct_answers, choices);
      if (!correctAnswers.length) {
        continue;
      }
      const explanation = normalizeExplanation(question.explanation || question.comment);
      const id = question.id ? String(question.id) : uuidv5(`${text}::${domain}`, DNS_NAMESPACE);
      result.push({
        id,
        question: text,
        choices,
        correct_answers: Array.from(new Set(correctAnswers)).sort((a, b) => a - b),
        comment: explanation,
        explanation,
        domain,
        group_id: group.id ? String(group.id) : '',
        group_context: context,
      });
    }
  }
  return result;
}

function buildGroupSummaries(bank) {
  const summaries = [];
  if (!bank || !Array.isArray(bank.groups)) {
    return summaries;
  }
  for (const group of bank.groups) {
    if (!group || typeof group !== 'object' || !Array.isArray(group.questions) || !group.questions.length) {
      continue;
    }
    const id = group.id ? String(group.id) : '';
    const domain = (group.domain || 'General').toString().trim() || 'General';
    const context = normalizeExplanation(group.context);
    const questions = [];
    const searchPieces = [context];
    for (const rawQuestion of group.questions) {
      if (!rawQuestion || typeof rawQuestion !== 'object') {
        continue;
      }
      const questionText = (rawQuestion.question || rawQuestion.prompt || rawQuestion.text || '').toString().trim();
      if (!questionText) {
        continue;
      }
      const rawChoices = Array.isArray(rawQuestion.choices) ? rawQuestion.choices : [];
      const choices = rawChoices.map((choice) => choice.toString());
      if (choices.length < 2) {
        continue;
      }
      const correctAnswers = Array.isArray(rawQuestion.correct_answers)
        ? rawQuestion.correct_answers
            .map((value) => Number.parseInt(value, 10))
            .filter((value) => Number.isInteger(value) && value >= 0 && value < choices.length)
        : normalizeCorrectAnswers(rawQuestion.correct_answers, choices);
      if (!correctAnswers.length) {
        continue;
      }
      const explanation = normalizeExplanation(rawQuestion.explanation || rawQuestion.comment);
      const questionId = rawQuestion.id
        ? String(rawQuestion.id)
        : uuidv5(`${id || 'group'}::${questionText}`, DNS_NAMESPACE);
      searchPieces.push(questionText);
      if (explanation) {
        searchPieces.push(explanation);
      }
      questions.push({
        id: questionId,
        question: questionText,
        choices,
        correct_answers: Array.from(new Set(correctAnswers)).sort((a, b) => a - b),
        explanation,
        comment: explanation,
        domain,
        group_id: id,
        group_context: context,
      });
    }
    if (!questions.length) {
      continue;
    }
    summaries.push({
      id,
      domain,
      context,
      questionCount: questions.length,
      questionIds: questions.map((question) => question.id),
      previewQuestions: questions.map((question) => question.question),
      questions,
      searchText: searchPieces.join(' ').toLowerCase(),
    });
  }
  return summaries;
}

function findQuestionLocation(bank, questionId) {
  if (!bank || !Array.isArray(bank.groups)) {
    return null;
  }
  for (let groupIndex = 0; groupIndex < bank.groups.length; groupIndex += 1) {
    const group = bank.groups[groupIndex];
    if (!group || !Array.isArray(group.questions)) {
      continue;
    }
    for (let questionIndex = 0; questionIndex < group.questions.length; questionIndex += 1) {
      const question = group.questions[questionIndex];
      if (question && String(question.id) === String(questionId)) {
        return { groupIndex, questionIndex };
      }
    }
  }
  return null;
}

function removeEmptyGroups(bank) {
  if (!bank || !Array.isArray(bank.groups)) {
    return bank;
  }
  bank.groups = bank.groups.filter((group) => group && Array.isArray(group.questions) && group.questions.length > 0);
  return bank;
}

function loadQuestionContext() {
  const bank = loadQuestionBank();
  const groups = buildGroupSummaries(bank);
  const questions = flattenQuestionBank(bank);
  const domainSource = groups.length ? groups : questions;
  const domains = Array.from(new Set(domainSource.map((item) => item.domain || 'General'))).sort();
  return {
    bank,
    questions,
    groups,
    domains,
    questionCount: questions.length,
    groupCount: groups.length,
  };
}

function buildExportPayload(bank, selectedGroupIds) {
  const includeAll = !selectedGroupIds;
  const idSet = includeAll ? null : new Set(selectedGroupIds.map((value) => String(value)));
  const groups = [];
  if (bank && Array.isArray(bank.groups)) {
    for (const group of bank.groups) {
      if (!group || !Array.isArray(group.questions) || !group.questions.length) {
        continue;
      }
      const groupId = group.id ? String(group.id) : '';
      if (!includeAll && (!groupId || !idSet || !idSet.has(groupId))) {
        continue;
      }
      const exportQuestions = group.questions.map((question) => ({
        id: question.id ? String(question.id) : undefined,
        question: (question.question || question.prompt || '').toString(),
        choices: Array.isArray(question.choices) ? question.choices.map((choice) => choice.toString()) : [],
        correct_answers: Array.isArray(question.correct_answers)
          ? Array.from(
              new Set(
                question.correct_answers
                  .map((value) => Number.parseInt(value, 10))
                  .filter((value) => Number.isInteger(value)),
              ),
            ).sort((a, b) => a - b)
          : [],
        explanation: normalizeExplanation(question.explanation || question.comment),
      }));
      groups.push({
        id: groupId || undefined,
        domain: (group.domain || 'General').toString().trim() || 'General',
        context: normalizeExplanation(group.context),
        questions: exportQuestions,
      });
    }
  }
  return { version: QUESTION_BANK_VERSION, groups };
}

function removeQuestionsById(bank, idsToRemove) {
  if (!bank || !Array.isArray(bank.groups) || !idsToRemove || !idsToRemove.size) {
    return 0;
  }
  let removed = 0;
  for (const group of bank.groups) {
    if (!group || !Array.isArray(group.questions)) {
      continue;
    }
    const before = group.questions.length;
    group.questions = group.questions.filter((question) => !idsToRemove.has(String(question.id)));
    removed += before - group.questions.length;
  }
  removeEmptyGroups(bank);
  return removed;
}

function removeGroupsById(bank, idsToRemove) {
  if (!bank || !Array.isArray(bank.groups) || !idsToRemove || !idsToRemove.size) {
    return 0;
  }
  const before = bank.groups.length;
  bank.groups = bank.groups.filter((group) => !idsToRemove.has(String(group.id)));
  return before - bank.groups.length;
}

function filterQuestionsByParams(questions, domainFilter, searchFilter) {
  const domain = (domainFilter || '').trim();
  const search = (searchFilter || '').trim();
  const searchLower = search.toLowerCase();
  return questions.filter((question) => {
    if (domain && question.domain !== domain) {
      return false;
    }
    if (searchLower) {
      const haystack = `${question.question || ''} ${question.comment || ''}`.toLowerCase();
      if (!haystack.includes(searchLower)) {
        return false;
      }
    }
    return true;
  });
}

function filterGroupsByParams(groups, domainFilter, searchFilter) {
  const domain = (domainFilter || '').trim();
  const search = (searchFilter || '').trim().toLowerCase();
  return groups.filter((group) => {
    if (domain && group.domain !== domain) {
      return false;
    }
    if (search && (!group.searchText || !group.searchText.includes(search))) {
      return false;
    }
    return true;
  });
}

function collectGroupQuestionIds(groups, idSet) {
  const questionIds = new Set();
  if (!idSet || !idSet.size || !Array.isArray(groups)) {
    return questionIds;
  }
  for (const group of groups) {
    if (!group) {
      continue;
    }
    const groupId = group.id !== undefined && group.id !== null ? String(group.id) : '';
    if (!groupId || !idSet.has(groupId)) {
      continue;
    }
    if (Array.isArray(group.questionIds)) {
      for (const questionId of group.questionIds) {
        questionIds.add(questionId);
      }
    }
  }
  return questionIds;
}

function buildQuestionRedirectUrl(pageParam, domainFilter, searchFilter) {
  const domain = (domainFilter || '').trim();
  const search = (searchFilter || '').trim();
  const page = Number.isFinite(pageParam) && pageParam >= 1 ? pageParam : 1;
  const params = new URLSearchParams();
  if (domain) {
    params.set('domain', domain);
  }
  if (search) {
    params.set('q', search);
  }
  params.set('page', String(page));
  const query = params.toString();
  return query ? `/questions?${query}` : '/questions';
}

function parseChoicesInput(value) {
  if (!value) {
    return [];
  }
  return value
    .split(/\r?\n/)
    .map((choice) => choice.trim())
    .filter((choice) => choice);
}

function parseCorrectAnswersInput(value) {
  if (!value) {
    return [];
  }
  return value
    .split(/[,\n]+/)
    .map((item) => item.trim())
    .filter((item) => item);
}

function normalizeIncomingGroup(rawGroup) {
  if (!rawGroup || typeof rawGroup !== 'object') {
    return null;
  }
  const group = {
    id: rawGroup.id || rawGroup.group_id || rawGroup.groupId || rawGroup.uuid,
    domain: rawGroup.domain || rawGroup.category || rawGroup.section,
    context: rawGroup.context || rawGroup.group_context || rawGroup.shared_context,
    questions: rawGroup.questions || rawGroup.items || rawGroup.data,
  };
  return sanitizeGroup(group);
}

function normalizeQuestionToGroup(rawQuestion) {
  try {
    const normalized = normalizeQuestion(rawQuestion);
    const explanation = normalizeExplanation(rawQuestion.comment || rawQuestion.explanation);
    const context = normalizeExplanation(rawQuestion.context);
    const groupId = rawQuestion.group_id || rawQuestion.groupId || rawQuestion.group || null;
    return sanitizeGroup({
      id: groupId || `group-${normalized.id}`,
      domain: normalized.domain,
      context,
      questions: [
        {
          id: normalized.id,
          question: normalized.question,
          choices: normalized.choices,
          correct_answers: normalized.correct_answers,
          explanation,
        },
      ],
    });
  } catch (error) {
    return null;
  }
}

function importQuestions(rawData) {
  const bank = loadQuestionBank();
  if (!Array.isArray(bank.groups)) {
    bank.groups = [];
  }
  const groupIndexById = new Map();
  bank.groups.forEach((group, index) => {
    if (group && group.id) {
      groupIndexById.set(String(group.id), index);
    }
  });

  let imported = 0;
  let updated = 0;
  const incomingGroups = [];

  if (Array.isArray(rawData)) {
    for (const item of rawData) {
      const group = normalizeQuestionToGroup(item);
      if (group) {
        incomingGroups.push(group);
      }
    }
  } else if (rawData && typeof rawData === 'object') {
    let groupCandidates = [];
    if (Array.isArray(rawData.groups)) {
      groupCandidates = rawData.groups;
    } else if (Array.isArray(rawData.question_groups)) {
      groupCandidates = rawData.question_groups;
    } else if (Array.isArray(rawData.data)) {
      groupCandidates = rawData.data;
    } else if (Array.isArray(rawData.questions)) {
      groupCandidates = rawData.questions;
    }
    if (groupCandidates.length) {
      const looksLikeGroups = groupCandidates.every((item) => item && typeof item === 'object' && (item.questions || item.items || item.data));
      if (looksLikeGroups) {
        for (const item of groupCandidates) {
          const group = normalizeIncomingGroup(item);
          if (group) {
            incomingGroups.push(group);
          }
        }
      } else {
        for (const item of groupCandidates) {
          const group = normalizeQuestionToGroup(item);
          if (group) {
            incomingGroups.push(group);
          }
        }
      }
    }
  }

  if (!incomingGroups.length) {
    throw new Error('Unsupported format. Provide groups with questions or a list of questions.');
  }

  for (const incoming of incomingGroups) {
    const groupId = incoming.id || crypto.randomUUID();
    let groupIndex = groupIndexById.get(groupId);
    if (groupIndex === undefined) {
      bank.groups.push({ id: groupId, domain: incoming.domain, context: incoming.context, questions: [] });
      groupIndex = bank.groups.length - 1;
      groupIndexById.set(groupId, groupIndex);
    }
    const targetGroup = bank.groups[groupIndex];
    targetGroup.domain = incoming.domain;
    targetGroup.context = incoming.context;
    if (!Array.isArray(targetGroup.questions)) {
      targetGroup.questions = [];
    }
    for (const question of incoming.questions) {
      const location = findQuestionLocation(bank, question.id);
      if (location) {
        const { groupIndex: existingGroupIndex, questionIndex } = location;
        const existingGroup = bank.groups[existingGroupIndex];
        if (existingGroup && Array.isArray(existingGroup.questions)) {
          if (existingGroupIndex === groupIndex) {
            existingGroup.questions[questionIndex] = question;
          } else {
            existingGroup.questions.splice(questionIndex, 1);
            targetGroup.questions.push(question);
          }
        }
        updated += 1;
      } else {
        targetGroup.questions.push(question);
        imported += 1;
      }
    }
  }

  removeEmptyGroups(bank);
  saveQuestionBank(bank);
  return { imported, updated };
}

function stripChoiceLabel(value) {
  if (value === undefined || value === null) {
    return '';
  }
  const trimmed = value.toString().trim();
  const match = trimmed.match(/^([A-L])[).、:：\-–—]?\s+(.*)$/i);
  if (match && match[2]) {
    const remainder = match[2].trim();
    if (remainder) {
      return remainder;
    }
  }
  return trimmed;
}

function normalizeAiChoices(rawChoices) {
  if (!rawChoices) {
    return [];
  }
  if (Array.isArray(rawChoices)) {
    const normalized = [];
    for (const choice of rawChoices) {
      if (choice === undefined || choice === null) {
        continue;
      }
      if (typeof choice === 'string' || typeof choice === 'number') {
        const value = stripChoiceLabel(choice);
        if (value) {
          normalized.push(value);
        }
        continue;
      }
      if (typeof choice === 'object') {
        if (typeof choice.text === 'string' && choice.text.trim()) {
          const value = stripChoiceLabel(choice.text);
          if (value) {
            normalized.push(value);
          }
          continue;
        }
        if (typeof choice.value === 'string' || typeof choice.value === 'number') {
          const value = stripChoiceLabel(choice.value);
          if (value) {
            normalized.push(value);
          }
          continue;
        }
        if (typeof choice.option === 'string' && choice.option.trim()) {
          const value = stripChoiceLabel(choice.option);
          if (value) {
            normalized.push(value);
          }
          continue;
        }
        if (typeof choice.content === 'string' && choice.content.trim()) {
          const value = stripChoiceLabel(choice.content);
          if (value) {
            normalized.push(value);
          }
          continue;
        }
        if (typeof choice.label === 'string' && choice.label.trim()) {
          const value = stripChoiceLabel(choice.label);
          if (value) {
            normalized.push(value);
          }
        }
      }
    }
    return normalized;
  }
  if (typeof rawChoices === 'object') {
    const entries = Object.entries(rawChoices)
      .map(([key, value]) => ({ key, value }))
      .sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true, sensitivity: 'base' }));
    const normalized = [];
    for (const entry of entries) {
      if (entry.value === undefined || entry.value === null) {
        continue;
      }
      const value = Array.isArray(entry.value) ? entry.value.join(' ') : entry.value.toString();
      const trimmed = stripChoiceLabel(value);
      if (trimmed) {
        normalized.push(trimmed);
      }
    }
    return normalized;
  }
  return [];
}

function unwrapAiAnswerValue(value) {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    if (value.length && value.every((item) => item && typeof item === 'object')) {
      const flattened = [];
      for (const item of value) {
        if (item === undefined || item === null) {
          continue;
        }
        if (typeof item === 'string' || typeof item === 'number') {
          flattened.push(item);
          continue;
        }
        if (typeof item.label === 'string') {
          flattened.push(item.label);
          continue;
        }
        if (typeof item.value === 'string' || typeof item.value === 'number') {
          flattened.push(item.value);
          continue;
        }
        if (typeof item.text === 'string') {
          flattened.push(item.text);
        }
      }
      if (flattened.length) {
        return flattened;
      }
    }
    return value;
  }
  if (typeof value === 'object') {
    if (Array.isArray(value.letters)) {
      return value.letters;
    }
    if (Array.isArray(value.indices)) {
      return value.indices;
    }
    if (Array.isArray(value.indexes)) {
      return value.indexes;
    }
    if (value.letter !== undefined) {
      return [value.letter];
    }
    if (value.index !== undefined) {
      return [value.index];
    }
    if (value.value !== undefined) {
      return Array.isArray(value.value) ? value.value : [value.value];
    }
    if (value.text !== undefined) {
      return [value.text];
    }
  }
  return value;
}

function extractAiAnswerValue(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    return undefined;
  }
  const answerKeys = [
    'correct_answers',
    'correct_answer',
    'answers',
    'answer',
    'correct',
    'key',
    'correctOption',
    'correct_option',
    'answer_letters',
    'answerLetter',
    'answer_letter',
    'answer_key',
    'correct_choice',
  ];
  for (const key of answerKeys) {
    if (key in candidate) {
      return unwrapAiAnswerValue(candidate[key]);
    }
  }
  if (candidate.solution && typeof candidate.solution === 'object') {
    return unwrapAiAnswerValue(candidate.solution.answer || candidate.solution.correct);
  }
  if (typeof candidate.solution === 'string') {
    return candidate.solution;
  }
  return undefined;
}

function resolveDomainInput(selection, customValue, fallback = 'General') {
  const trimmedSelection = (selection || '').trim();
  const trimmedCustom = (customValue || '').trim();
  if (trimmedSelection === '__custom__') {
    return trimmedCustom || fallback;
  }
  if (trimmedSelection) {
    return trimmedSelection;
  }
  if (trimmedCustom) {
    return trimmedCustom;
  }
  return fallback;
}

async function callQwenStructuredImport(rawText, domain, extraInstructions = '') {
  if (!QWEN_API_KEY || !QWEN_API_KEY.trim()) {
    throw new Error('Set the DASHSCOPE_API_KEY environment variable to enable AI-assisted imports.');
  }
  if (!rawText || !rawText.trim()) {
    throw new Error('Provide source text for AI import.');
  }
  if (typeof fetch !== 'function') {
    throw new Error('The current runtime does not support fetch, which is required for AI imports.');
  }
  const instructionParts = [
    'You are given CISSP-style multiple choice questions followed by their answers.',
    'Return strict JSON using UTF-8 characters only.',
    'If the source contains grouped scenarios, respond with { "groups": [ { "domain": "...", "context": "...", "questions": [ { "question": "...", "choices": ["..."], "answers": ["A"], "explanation": "..." } ] } ] }.',
    'When questions are independent, respond with { "questions": [ { "question": "...", "choices": ["..."], "answers": ["A"], "explanation": "..." } ] }.',
    'Never prefix the answer choices with letters such as "A." or "B)"—return only the choice text.',
    'Each question must include the full text, an ordered list of choices, the correct answer letters, and optional explanations.',
    'Preserve the original ordering of the questions and keep answer letters aligned with the provided choices.',
    'Do not include any text outside of the JSON structure.',
  ];
  if (extraInstructions && extraInstructions.trim()) {
    instructionParts.push(`Additional user instructions: ${extraInstructions.trim()}`);
  }
  const instructions = instructionParts.join(' ');
  const payload = {
    model: QWEN_MODEL,
    input: {
      prompt: `${instructions}\n\nDomain: ${domain || 'General'}\n\nInput:\n${rawText.trim()}`,
    },
  };
  let response;
  try {
    response = await fetch(QWEN_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${QWEN_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    throw new Error(`Failed to reach the Qwen service: ${error.message}`);
  }
  const errorText = !response.ok ? await response.text().catch(() => '') : '';
  if (!response.ok) {
    const preview = errorText ? `: ${errorText.slice(0, 300)}` : '';
    throw new Error(`Qwen request failed with status ${response.status}${preview}`);
  }
  let data;
  try {
    data = await response.json();
  } catch (error) {
    throw new Error(`Unable to parse Qwen response as JSON: ${error.message}`);
  }
  if (data && typeof data === 'object' && Array.isArray(data.questions)) {
    return data;
  }
  let content = '';
  if (data && typeof data === 'object') {
    if (typeof data.output === 'string') {
      content = data.output;
    } else if (data.output && typeof data.output.text === 'string') {
      content = data.output.text;
    } else if (Array.isArray(data.output?.choices) && data.output.choices.length) {
      const choice = data.output.choices[0];
      if (choice && typeof choice.text === 'string') {
        content = choice.text;
      }
    } else if (Array.isArray(data.choices) && data.choices.length) {
      const choice = data.choices[0];
      if (choice && typeof choice.message?.content === 'string') {
        content = choice.message.content;
      } else if (typeof choice.text === 'string') {
        content = choice.text;
      }
    }
  }
  if (!content) {
    throw new Error('Qwen response did not include any text to parse.');
  }
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  const jsonText = jsonMatch ? jsonMatch[0] : content;
  try {
    return JSON.parse(jsonText);
  } catch (error) {
    throw new Error('Failed to parse the structured JSON returned by Qwen.');
  }
}

async function prepareAiImportFromRaw(rawText, domain, extraInstructions = '') {
  const effectiveDomain = domain && domain.trim() ? domain.trim() : 'General';
  const parsed = await callQwenStructuredImport(rawText, effectiveDomain, extraInstructions);
  const groups = [];

  function buildQuestion(candidate, fallbackDomain) {
    if (!candidate || typeof candidate !== 'object') {
      return null;
    }
    const questionText = (candidate.question || candidate.prompt || candidate.text || '').toString().trim();
    if (!questionText) {
      throw new Error('One of the AI-generated questions is missing its text.');
    }
    const rawChoices =
      candidate.choices ||
      candidate.options ||
      candidate.choice_list ||
      candidate.option_list ||
      (candidate.answers && candidate.answers.options);
    const choices = normalizeAiChoices(rawChoices);
    if (choices.length < 2) {
      throw new Error(`AI response for "${questionText}" is missing multiple choices.`);
    }
    const explanation = normalizeExplanation(
      candidate.explanation || candidate.comment || candidate.rationale || candidate.analysis || '',
    );
    const answersValue = extractAiAnswerValue(candidate);
    const domainValue = (candidate.domain || candidate.category || fallbackDomain || 'General')
      .toString()
      .trim() || fallbackDomain || 'General';
    let normalized;
    try {
      normalized = normalizeQuestion({
        id: candidate.id,
        question: questionText,
        choices,
        correct_answers: answersValue,
        domain: domainValue,
        comment: explanation,
      });
    } catch (error) {
      throw new Error(`Unable to normalize AI question "${questionText}": ${error.message}`);
    }
    return {
      id: normalized.id,
      question: normalized.question,
      choices: normalized.choices,
      correct_answers: normalized.correct_answers,
      explanation: normalized.comment,
      domain: normalized.domain,
      context: normalizeExplanation(
        candidate.context || candidate.group_context || candidate.shared_context || candidate.scenario || '',
      ),
      groupHint: candidate.group_id || candidate.groupId || candidate.group || candidate.group_uuid || null,
    };
  }

  function addGroupFromCandidate(groupCandidate) {
    if (!groupCandidate || typeof groupCandidate !== 'object') {
      return;
    }
    const groupDomain = (groupCandidate.domain || groupCandidate.category || effectiveDomain)
      .toString()
      .trim() || effectiveDomain;
    const contextValue = normalizeExplanation(
      groupCandidate.context || groupCandidate.group_context || groupCandidate.shared_context || groupCandidate.scenario || '',
    );
    const questionEntries = Array.isArray(groupCandidate.questions)
      ? groupCandidate.questions
      : Array.isArray(groupCandidate.items)
      ? groupCandidate.items
      : Array.isArray(groupCandidate.data)
      ? groupCandidate.data
      : [];
    if (!questionEntries.length) {
      return;
    }
    const sanitizedQuestions = [];
    for (const entry of questionEntries) {
      const normalized = buildQuestion(entry, groupDomain);
      if (normalized) {
        sanitizedQuestions.push({
          id: normalized.id,
          question: normalized.question,
          choices: normalized.choices,
          correct_answers: normalized.correct_answers,
          explanation: normalized.explanation,
        });
      }
    }
    if (!sanitizedQuestions.length) {
      return;
    }
    const sanitizedGroup = sanitizeGroup({
      id: groupCandidate.id || groupCandidate.group_id || groupCandidate.groupId || groupCandidate.uuid || null,
      domain: groupDomain,
      context: contextValue,
      questions: sanitizedQuestions,
    });
    if (sanitizedGroup) {
      groups.push(sanitizedGroup);
    }
  }

  function addSingleQuestionGroup(questionCandidate) {
    const normalized = buildQuestion(questionCandidate, effectiveDomain);
    if (!normalized) {
      return;
    }
    const sanitizedGroup = sanitizeGroup({
      id: normalized.groupHint || `group-${normalized.id}`,
      domain: normalized.domain,
      context: normalized.context,
      questions: [
        {
          id: normalized.id,
          question: normalized.question,
          choices: normalized.choices,
          correct_answers: normalized.correct_answers,
          explanation: normalized.explanation,
        },
      ],
    });
    if (sanitizedGroup) {
      groups.push(sanitizedGroup);
    }
  }

  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      addSingleQuestionGroup(item);
    }
  } else if (parsed && typeof parsed === 'object') {
    const potentialGroupArrays = [parsed.groups, parsed.question_groups, parsed.data];
    let handledGroups = false;
    for (const candidateList of potentialGroupArrays) {
      if (!Array.isArray(candidateList) || !candidateList.length) {
        continue;
      }
      const looksLikeGroups = candidateList.every(
        (item) => item && typeof item === 'object' && (item.questions || item.items || item.data),
      );
      if (looksLikeGroups) {
        for (const candidate of candidateList) {
          addGroupFromCandidate(candidate);
        }
        handledGroups = groups.length > 0;
        if (handledGroups) {
          break;
        }
      }
    }
    if (!handledGroups) {
      const questionLists = [parsed.questions, parsed.items, !Array.isArray(parsed.data) ? null : parsed.data];
      for (const list of questionLists) {
        if (!Array.isArray(list) || !list.length) {
          continue;
        }
        for (const entry of list) {
          addSingleQuestionGroup(entry);
        }
        if (groups.length) {
          break;
        }
      }
    }
  }

  if (!groups.length) {
    throw new Error('Qwen did not return any questions to import.');
  }

  const previewGroups = groups.map((group) => ({
    id: group.id,
    domain: group.domain,
    context: group.context,
    questions: group.questions.map((question) => ({
      question: question.question,
      choices: question.choices,
      answerLetters: question.correct_answers.map((index) => String.fromCharCode(65 + index)),
      comment: question.explanation || '',
    })),
  }));
  const questionCount = previewGroups.reduce((total, group) => total + (group.questions?.length || 0), 0);
  if (!questionCount) {
    throw new Error('No valid questions were produced from the AI response.');
  }
  return {
    importPayload: { version: QUESTION_BANK_VERSION, groups },
    previewGroups,
    questionCount,
    domain: effectiveDomain,
  };
}

function joinAndNormalizeLines(lines) {
  const compacted = lines
    .join('\n')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return compacted;
}

function parseStructuredTextImport(rawText, domainInput) {
  if (!rawText || !rawText.trim()) {
    throw new Error('The provided text is empty.');
  }
  const domain = (domainInput || '').toString().trim() || 'General';
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ''));
  const answerHeadingRegex = /^\s*(?:答案|Answer(?:s)?|Answer\s*Key|解答|解析)\b/i;
  let splitIndex = lines.findIndex((line) => answerHeadingRegex.test(line));
  if (splitIndex === -1) {
    splitIndex = lines.findIndex((line) => /^\s*Answers?\s*:?.*$/i.test(line));
  }
  if (splitIndex === -1) {
    throw new Error('Unable to locate the answer section. Add a heading like "Answers" or "答案".');
  }
  const questionLines = lines.slice(0, splitIndex);
  const answerLines = lines.slice(splitIndex);
  if (answerLines.length && answerHeadingRegex.test(answerLines[0])) {
    answerLines.shift();
  }

  const questions = [];
  let currentQuestion = null;
  let currentChoice = null;
  let activeContext = [];
  let pendingContext = [];

  function commitChoice() {
    if (currentQuestion && currentChoice) {
      const label = currentChoice.label;
      const text = joinAndNormalizeLines(currentChoice.lines);
      if (text) {
        currentQuestion.choices.push({ label, text });
      }
    }
    currentChoice = null;
  }

  function commitQuestion() {
    if (!currentQuestion) {
      return;
    }
    commitChoice();
    const questionBody = joinAndNormalizeLines(currentQuestion.questionLines);
    if (!questionBody) {
      throw new Error(`Question ${currentQuestion.number} is missing text.`);
    }
    if (currentQuestion.choices.length < 2) {
      throw new Error(`Question ${currentQuestion.number} must include at least two choices.`);
    }
    const sortedChoices = currentQuestion.choices
      .slice()
      .sort((a, b) => a.label.localeCompare(b.label));
    const combinedParts = [];
    if (activeContext.length) {
      const contextText = joinAndNormalizeLines(activeContext);
      if (contextText) {
        combinedParts.push(contextText);
      }
    }
    combinedParts.push(questionBody);
    questions.push({
      number: currentQuestion.number,
      text: combinedParts.join('\n\n').trim(),
      choices: sortedChoices.map((item) => item.text),
    });
    currentQuestion = null;
  }

  const choiceRegex = /^([A-L])[).、]\s*(.*)$/i;
  const questionRegex = /^(\d+)[).、]\s*(.*)$/;

  for (const line of questionLines) {
    const trimmed = line.trim();
    if (!currentQuestion) {
      if (!trimmed) {
        if (pendingContext.length) {
          pendingContext.push('');
        }
        continue;
      }
      const questionMatch = trimmed.match(questionRegex);
      if (questionMatch) {
        commitQuestion();
        if (pendingContext.length) {
          activeContext = pendingContext.slice();
          pendingContext = [];
        }
        currentQuestion = {
          number: Number.parseInt(questionMatch[1], 10),
          questionLines: [questionMatch[2] || ''],
          choices: [],
        };
        currentChoice = null;
        continue;
      }
      pendingContext.push(line);
      continue;
    }
    if (!trimmed) {
      if (currentChoice) {
        currentChoice.lines.push('');
      } else {
        currentQuestion.questionLines.push('');
      }
      continue;
    }
    const choiceMatch = trimmed.match(choiceRegex);
    if (choiceMatch) {
      commitChoice();
      currentChoice = {
        label: choiceMatch[1].toUpperCase(),
        lines: [choiceMatch[2] || ''],
      };
      continue;
    }
    if (currentChoice) {
      currentChoice.lines.push(line);
    } else {
      currentQuestion.questionLines.push(line);
    }
  }
  commitQuestion();

  if (!questions.length) {
    throw new Error('No questions were detected in the provided text.');
  }

  const answers = new Map();
  const answerEntryRegex = /^(?:答案|Answer(?:s)?|解答|解析|正确答案)?\s*(\d+)[).:：-]?\s*(.*)$/i;
  let currentAnswer = null;

  function parseAnswerTokens(value) {
    if (!value) {
      return { letters: [], explanationPart: '' };
    }
    let working = value.replace(/^(?:答案|Answer(?:s)?|解答|解析|正确答案)\s*[:：]?/i, '').trim();
    const explanationKeywords = /(解析|Explanation|解釋|解释|因为|因為|Rationale)\s*[:：]?/i;
    let explanationPart = '';
    const keywordMatch = working.match(explanationKeywords);
    if (keywordMatch) {
      const index = working.indexOf(keywordMatch[0]);
      if (index !== -1) {
        explanationPart = working.slice(index).trim();
        working = working.slice(0, index).trim();
      }
    }
    const cleaned = working.replace(/\band\b/gi, ',').replace(/&/g, ',');
    const tokens = cleaned
      .split(/[,/\s]+/)
      .map((token) => token.trim())
      .filter((token) => token);
    const letters = [];
    for (const token of tokens) {
      const strippedToken = token.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
      if (!strippedToken) {
        continue;
      }
      const normalizedToken = strippedToken.toUpperCase();
      if (/^[A-L]$/.test(normalizedToken)) {
        letters.push(normalizedToken);
      } else if (/^[A-L]{2,}$/.test(normalizedToken)) {
        for (const char of normalizedToken) {
          if (/^[A-L]$/.test(char)) {
            letters.push(char);
          }
        }
      }
    }
    if (!letters.length) {
      const fallback = value.match(/\b[A-L]\b/g);
      if (fallback) {
        for (const char of fallback) {
          letters.push(char);
        }
      }
    }
    const uniqueLetters = Array.from(new Set(letters));
    return { letters: uniqueLetters, explanationPart };
  }

  function finalizeAnswer() {
    if (!currentAnswer) {
      return;
    }
    const explanation = joinAndNormalizeLines(currentAnswer.lines);
    answers.set(currentAnswer.number, {
      letters: currentAnswer.letters,
      explanation,
    });
    currentAnswer = null;
  }

  for (const rawLine of answerLines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      continue;
    }
    if (answerHeadingRegex.test(trimmed)) {
      continue;
    }
    const match = trimmed.match(answerEntryRegex);
    if (match) {
      finalizeAnswer();
      const number = Number.parseInt(match[1], 10);
      const { letters, explanationPart } = parseAnswerTokens(match[2] || '');
      currentAnswer = {
        number,
        letters,
        lines: explanationPart ? [explanationPart] : [],
      };
      continue;
    }
    if (currentAnswer) {
      currentAnswer.lines.push(rawLine);
    }
  }
  finalizeAnswer();

  const preparedQuestions = questions.map((question) => {
    if (!answers.has(question.number)) {
      throw new Error(`No answer was found for question ${question.number}.`);
    }
    const { letters, explanation } = answers.get(question.number);
    if (!letters.length) {
      throw new Error(`Question ${question.number} is missing a valid answer option.`);
    }
    const indexes = [];
    for (const letter of letters) {
      const idx = letter.charCodeAt(0) - 65;
      if (idx < 0 || idx >= question.choices.length) {
        throw new Error(`Answer ${letter} for question ${question.number} does not match any choice.`);
      }
      if (!indexes.includes(idx)) {
        indexes.push(idx);
      }
    }
    if (!indexes.length) {
      throw new Error(`Question ${question.number} is missing a valid answer option.`);
    }
    indexes.sort((a, b) => a - b);
    return {
      question: question.text,
      choices: question.choices,
      correct_answers: indexes,
      domain,
      comment: explanation,
    };
  });

  return preparedQuestions;
}

function loadWrongAnswers() {
  return readJson(WRONG_FILE);
}

function saveWrongAnswers(data) {
  writeJson(WRONG_FILE, data);
}

function updateWrongAnswers(questionId, selectedIndices, isCorrect) {
  const wrongAnswers = loadWrongAnswers();
  const lookup = new Map();
  for (const item of wrongAnswers) {
    if (item && item.question_id) {
      lookup.set(item.question_id, item);
    }
  }
  if (isCorrect) {
    if (lookup.has(questionId)) {
      lookup.delete(questionId);
      saveWrongAnswers(Array.from(lookup.values()));
    }
    return;
  }
  if (lookup.has(questionId)) {
    const entry = lookup.get(questionId);
    entry.wrong_count = (entry.wrong_count || 0) + 1;
    entry.last_attempt = new Date().toISOString();
    entry.last_answer = selectedIndices;
    lookup.set(questionId, entry);
  } else {
    lookup.set(questionId, {
      question_id: questionId,
      wrong_count: 1,
      last_attempt: new Date().toISOString(),
      last_answer: selectedIndices,
    });
  }
  saveWrongAnswers(Array.from(lookup.values()));
}

function parseCookies(cookieHeader) {
  const result = {};
  if (!cookieHeader) {
    return result;
  }
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const [key, value] = part.trim().split('=');
    if (key && value !== undefined) {
      result[key] = decodeURIComponent(value);
    }
  }
  return result;
}

function getSession(req, res) {
  const cookies = parseCookies(req.headers.cookie || '');
  let sid = cookies.session_id;
  if (!sid || !sessions.has(sid)) {
    sid = crypto.randomUUID();
    sessions.set(sid, {});
    res.setHeader('Set-Cookie', `session_id=${sid}; HttpOnly; Path=/`);
  }
  return sessions.get(sid);
}

function sendHtml(res, html, status = 200) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(html);
}

function redirect(res, location) {
  res.statusCode = 302;
  res.setHeader('Location', location);
  res.end();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderLayout({ title, questionCount, wrongCount, domains, flashMessages, body }) {
  const alerts = (flashMessages || [])
    .map(
      (msg) => `\
        <div class="alert alert-${escapeHtml(msg.category || 'info')} alert-dismissible fade show" role="alert">\
          ${escapeHtml(msg.message || '')}\
          <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>\
        </div>\
      `,
    )
    .join('\n');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title || 'CISSP Test Simulator')}</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
    <link rel="stylesheet" href="/static/styles.css">
  </head>
  <body>
    <nav class="navbar navbar-expand-lg navbar-dark bg-dark mb-4">
      <div class="container-fluid">
        <a class="navbar-brand" href="/">CISSP Test Simulator</a>
        <button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#navbarNav" aria-controls="navbarNav" aria-expanded="false" aria-label="Toggle navigation">
          <span class="navbar-toggler-icon"></span>
        </button>
        <div class="collapse navbar-collapse" id="navbarNav">
          <ul class="navbar-nav me-auto mb-2 mb-lg-0">
            <li class="nav-item">
              <a class="nav-link" href="/import/json">Import JSON</a>
            </li>
            <li class="nav-item">
              <a class="nav-link" href="/import/ai">AI Import (Qwen)</a>
            </li>
            <li class="nav-item">
              <a class="nav-link" href="/questions">Question Bank</a>
            </li>
            <li class="nav-item">
              <a class="nav-link" href="/test/new">New Test</a>
            </li>
            <li class="nav-item">
              <a class="nav-link" href="/review">Review Mistakes</a>
            </li>
          </ul>
          <div class="text-light small">
            <span class="me-3">Questions: ${escapeHtml(questionCount)}</span>
            <span>Mistakes saved: ${escapeHtml(wrongCount)}</span>
          </div>
        </div>
      </div>
    </nav>
    <main class="container mb-5">
      ${alerts}
      ${body}
    </main>
    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
  </body>
</html>`;
}

function renderIndex({ questionCount, wrongCount, domains, wrongDetails }) {
  const domainItems = domains.length
    ? domains.map((domain) => `<li class="list-group-item">${escapeHtml(domain)}</li>`).join('\n')
    : '<li class="list-group-item text-muted">No domains available yet.</li>';
  let wrongSection = '<p class="text-muted">Great job! No mistakes recorded yet.</p>';
  if (wrongDetails.length) {
    const rows = wrongDetails
      .map((item) => {
        const question = item.question || {};
        return `\
          <tr>\
            <td>${escapeHtml(question.question || item.question_id)}</td>\
            <td>${escapeHtml(question.domain || 'Unknown')}</td>\
            <td>${escapeHtml(item.last_attempt || 'N/A')}</td>\
            <td>${escapeHtml(item.wrong_count || 0)}</td>\
          </tr>\
        `;
      })
      .join('\n');
    wrongSection = `\
      <div class="table-responsive">\
        <table class="table table-striped align-middle">\
          <thead>\
            <tr>\
              <th scope="col">Question</th>\
              <th scope="col">Domain</th>\
              <th scope="col">Last Attempt</th>\
              <th scope="col">Times Missed</th>\
            </tr>\
          </thead>\
          <tbody>${rows}</tbody>\
        </table>\
      </div>\
    `;
  }
  return `
    <div class="row g-4">
      <div class="col-md-6">
        <div class="card h-100">
          <div class="card-body">
            <h5 class="card-title">Get Started</h5>
            <p class="card-text">Import your CISSP practice questions, launch a new test, or focus on the questions you previously missed.</p>
            <div class="d-grid gap-2">
              <a class="btn btn-primary" href="/import/json">Import Questions</a>
              <a class="btn btn-success${questionCount === 0 ? ' disabled' : ''}" href="${questionCount === 0 ? '#' : '/test/new'}">Start New Test</a>
              <a class="btn btn-outline-warning${wrongCount === 0 ? ' disabled' : ''}" href="${wrongCount === 0 ? '#' : '/review'}">Review Mistakes</a>
            </div>
          </div>
        </div>
      </div>
      <div class="col-md-6">
        <div class="card h-100">
          <div class="card-body">
            <h5 class="card-title">Question Bank Overview</h5>
            <p class="card-text">You currently have <strong>${escapeHtml(questionCount)}</strong> questions available across ${escapeHtml(domains.length)} domain(s).</p>
            <ul class="list-group list-group-flush">
              ${domainItems}
            </ul>
          </div>
        </div>
      </div>
    </div>
    <div class="row g-4 mt-1">
      <div class="col-12">
        <div class="card">
          <div class="card-body">
            <h5 class="card-title">Recent Mistakes</h5>
            ${wrongSection}
          </div>
        </div>
      </div>
    </div>
  `;
}

function buildDomainOptions(domains, selectedValue) {
  const normalized = new Set();
  normalized.add('General');
  for (const domain of domains) {
    if (!domain) {
      continue;
    }
    const value = domain.toString().trim();
    if (value) {
      normalized.add(value);
    }
  }
  const sorted = Array.from(normalized).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  const effectiveSelected = selectedValue === '__custom__' ? '__custom__' : (selectedValue || 'General');
  const options = sorted
    .map((domain) => {
      const selected = effectiveSelected !== '__custom__' && domain === effectiveSelected ? ' selected' : '';
      return `<option value="${escapeHtml(domain)}"${selected}>${escapeHtml(domain)}</option>`;
    })
    .join('\n');
  const customSelected = effectiveSelected === '__custom__' ? ' selected' : '';
  return `${options}\n<option value="__custom__"${customSelected}>Other (custom domain)</option>`;
}

function renderImportJson() {
  return `
    <div class="row justify-content-center">
      <div class="col-xl-8 col-lg-9">
        <div class="card">
          <div class="card-body">
            <h5 class="card-title">Import JSON</h5>
            <p class="card-text">Paste your questions as JSON or upload a JSON file organized into question groups. Each group includes its domain, an optional context, and one or more questions with choices and explanations.</p>
            <form method="post" enctype="multipart/form-data">
              <div class="mb-3">
                <label for="questions_json" class="form-label">Questions JSON</label>
                <textarea class="form-control" id="questions_json" name="questions_json" rows="10" placeholder="{ &quot;groups&quot;: [ ... ] }"></textarea>
                <div class="form-text">See <code>sample_data/sample_question_groups.json</code> for an example structure. You can leave this blank when uploading a file.</div>
              </div>
              <div class="mb-3">
                <label for="questions_file" class="form-label">Upload JSON file</label>
                <input class="form-control" type="file" id="questions_file" name="questions_file" accept="application/json,.json">
                <div class="form-text">When both are provided, the uploaded file takes priority.</div>
              </div>
              <button type="submit" class="btn btn-primary">Import JSON</button>
            </form>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderImportAi({
  domains = [],
  aiSelectedDomain = 'General',
  aiCustomDomain = '',
  aiSourceText = '',
  aiInstructionsText = '',
  aiPreview = null,
  qwenEnabled = false,
} = {}) {
  const aiOptions = buildDomainOptions(domains, aiSelectedDomain);
  const aiCustomValue = aiSelectedDomain === '__custom__' ? aiCustomDomain : '';
  const aiSourceValue = aiSourceText || '';
  const aiInstructionsValue = aiInstructionsText || '';
  const aiDisabledAttr = qwenEnabled ? '' : ' disabled';
  const aiNotice = qwenEnabled
    ? ''
    : '<div class="alert alert-warning mt-3" role="alert">Set the <code>DASHSCOPE_API_KEY</code> environment variable to enable AI-assisted imports.</div>';
  const previewSection = aiPreview
    ? (() => {
        const previewGroups = Array.isArray(aiPreview.groups) ? aiPreview.groups : [];
        const groupItems = previewGroups
          .map((group, groupIndex) => {
            const questions = Array.isArray(group.questions) ? group.questions : [];
            const questionItems = questions
              .map((question, questionIndex) => {
                const choiceItems = Array.isArray(question.choices)
                  ? question.choices
                      .map((choice, choiceIndex) => {
                        const label = String.fromCharCode(65 + choiceIndex);
                        return `<li><span class="fw-semibold">${escapeHtml(label)}.</span> ${escapeHtml(choice)}</li>`;
                      })
                      .join('\n')
                  : '';
                const explanation = question.comment
                  ? `<p class="mb-0"><strong>Explanation:</strong> ${escapeHtml(question.comment)}</p>`
                  : '';
                return `
                  <div class="mb-4">
                    <h6 class="fw-semibold">Question ${groupIndex + 1}.${questionIndex + 1}</h6>
                    <p>${escapeHtml(question.question || '')}</p>
                    <ol class="mb-2 ps-3" type="A">
                      ${choiceItems}
                    </ol>
                    <p class="mb-1"><strong>Correct:</strong> ${escapeHtml((question.answerLetters || []).join(', '))}</p>
                    ${explanation}
                  </div>
                `;
              })
              .join('\n');
            const contextBlock = group.context
              ? `<p class="mb-3"><strong>Context:</strong> ${escapeHtml(group.context)}</p>`
              : '';
            return `
              <div class="mb-4">
                <h5 class="fw-semibold mb-1">Group ${groupIndex + 1} · ${escapeHtml(group.domain || 'General')}</h5>
                ${contextBlock}
                ${questionItems || '<p class="text-muted fst-italic">No questions found in this group.</p>'}
              </div>
            `;
          })
          .join('\n');
        const groupCount = previewGroups.length;
        const questionCount = Number.isFinite(aiPreview.questionCount)
          ? aiPreview.questionCount
          : previewGroups.reduce((total, group) => total + (group.questions?.length || 0), 0);
        const questionCountLabel = escapeHtml(String(questionCount));
        const groupCountLabel = escapeHtml(String(groupCount || 1));
        const summaryLine = `Confirm the ${questionCountLabel} question${questionCount === 1 ? '' : 's'} across ${groupCountLabel} group${groupCount === 1 ? '' : 's'} extracted by Qwen.`;
        const defaultDomain = escapeHtml(aiPreview.domain || 'General');
        const payloadValue = aiPreview.payload ? escapeHtml(aiPreview.payload) : '';
        const originalText = aiPreview.source
          ? `
            <details class="mt-3">
              <summary>Show original text</summary>
              <pre class="mt-2 bg-light p-3 rounded border">${escapeHtml(aiPreview.source)}</pre>
            </details>
          `
          : '';
        return `
          <div class="card mt-4">
            <div class="card-body">
              <h5 class="card-title">Review AI parsed questions</h5>
              <p class="card-text">${summaryLine} The default domain for this batch is <strong>${defaultDomain}</strong>.</p>
              ${groupItems}
              <form method="post" class="mt-3">
                <input type="hidden" name="import_mode" value="ai_confirm">
                <div class="mb-3">
                  <label for="ai_payload" class="form-label">AI results JSON</label>
                  <textarea class="form-control font-monospace" id="ai_payload" name="ai_payload" rows="12">${payloadValue}</textarea>
                  <div class="form-text">Review and adjust the JSON before importing. Keep the structure valid to avoid errors.</div>
                </div>
                <button type="submit" class="btn btn-success">Import ${questionCountLabel} Question${questionCount === 1 ? '' : 's'}</button>
                <a class="btn btn-outline-secondary ms-2" href="/import/ai">Cancel</a>
              </form>
              ${originalText}
            </div>
          </div>
        `;
      })()
    : '';

  return `
    <div class="row justify-content-center">
      <div class="col-xl-8 col-lg-9">
        <div class="card h-100">
          <div class="card-body">
            <h5 class="card-title">AI-assisted import (Qwen)</h5>
            <p class="card-text">Let Qwen analyze raw question and answer text to produce structured questions that you can review before importing.</p>
            <form method="post">
              <input type="hidden" name="import_mode" value="ai_prepare">
              <div class="mb-3">
                <label for="ai_domain" class="form-label">Domain</label>
                <select class="form-select" id="ai_domain" name="ai_domain"${aiDisabledAttr}>
                  ${aiOptions}
                </select>
                <input type="text" class="form-control mt-2" id="ai_custom_domain" name="ai_custom_domain" placeholder="Custom domain" value="${escapeHtml(aiCustomValue || '')}"${aiDisabledAttr}>
                <div class="form-text">All questions in this batch will use the selected domain. Choose “Other” to specify a custom domain.</div>
              </div>
              <div class="mb-3">
                <label for="ai_source" class="form-label">Raw questions &amp; answers</label>
                <textarea class="form-control" id="ai_source" name="ai_source" rows="12" placeholder="Questions listed first, followed by the answer key."${aiDisabledAttr}>${escapeHtml(aiSourceValue)}</textarea>
                <div class="form-text">Provide the questions together followed by their answers. The assistant will match answers using the question numbers.</div>
              </div>
              <div class="mb-3">
                <label for="ai_instructions" class="form-label">Additional instructions <span class="text-muted">(optional)</span></label>
                <textarea class="form-control" id="ai_instructions" name="ai_instructions" rows="3" placeholder="Highlight tricky sections, request richer explanations, or describe expected grouping."${aiDisabledAttr}>${escapeHtml(aiInstructionsValue)}</textarea>
                <div class="form-text">Share any extra guidance to help Qwen produce better structured questions.</div>
              </div>
              <button type="submit" class="btn btn-primary"${aiDisabledAttr}>Analyze with Qwen</button>
            </form>
            ${aiNotice}
          </div>
        </div>
      </div>
    </div>
    ${previewSection}
  `;
}

function renderQuestionList({
  groups,
  page,
  totalPages,
  perPage,
  totalGroups,
  filters,
  availableDomains,
}) {
  const hasGroups = totalGroups > 0;
  const start = hasGroups ? (page - 1) * perPage + 1 : 0;
  const end = hasGroups ? Math.min(start + perPage - 1, totalGroups) : 0;
  const filterDomain = filters.domain || '';
  const filterSearch = filters.search || '';
  const hasActiveFilters = Boolean(filterDomain || filterSearch);
  const domainOptions = availableDomains
    .map((domain) => {
      const selected = domain === filterDomain ? ' selected' : '';
      return `<option value="${escapeHtml(domain)}"${selected}>${escapeHtml(domain)}</option>`;
    })
    .join('\n');
  const toSingleLine = (value) => value.replace(/\s+/g, ' ').trim();
  const truncateText = (value, limit = 160) => {
    if (value.length <= limit) {
      return value;
    }
    return `${value.slice(0, limit).trimEnd()}...`;
  };
  const rows = groups
    .map((group, index) => {
      const groupId = group && group.id ? String(group.id) : '';
      const questionCount = Number.isFinite(group && group.questionCount)
        ? Number(group.questionCount)
        : Array.isArray(group && group.questions)
        ? group.questions.length
        : 0;
      const hasMultipleQuestions = questionCount > 1;
      const previewQuestions = Array.isArray(group && group.previewQuestions) ? group.previewQuestions : [];
      const firstQuestion = previewQuestions.length ? toSingleLine(String(previewQuestions[0])) : '';
      const normalizedContext = group && group.context ? toSingleLine(String(group.context)) : '';
      const questionSummary = hasMultipleQuestions
        ? normalizedContext
          ? `<p class="mb-0 small">${escapeHtml(truncateText(normalizedContext))}</p>`
          : '<p class="mb-0 small text-muted fst-italic">No shared context.</p>'
        : firstQuestion
        ? `<p class="mb-0 small">${escapeHtml(firstQuestion)}</p>`
        : '<p class="mb-0 small text-muted fst-italic">No question text available.</p>';
      const headingPrefix = hasMultipleQuestions ? 'Question group' : 'Question';
      const headingNumber = hasGroups ? start + index : index + 1;
      const headingLabel = `${headingPrefix} ${headingNumber}`;
      return `
        <tr>
          <td class="text-center">
            <input class="form-check-input" type="checkbox" name="selected" value="${escapeHtml(groupId)}" form="exportForm" aria-label="Select group" data-select-item>
          </td>
          <td>
            <div class="fw-semibold">${escapeHtml(headingLabel)}</div>
            ${questionSummary}
          </td>
          <td>${escapeHtml(group.domain || 'General')}</td>
          <td class="text-center">${escapeHtml(String(group.questionCount || 0))}</td>
          <td class="text-nowrap">
            <a class="btn btn-sm btn-outline-secondary" href="/questions/view-group?id=${encodeURIComponent(groupId)}">View</a>
          </td>
        </tr>
      `;
    })
    .join('\n');
  const paginationItems = Array.from({ length: totalPages }, (_, index) => index + 1)
    .map((number) => {
      const activeClass = number === page ? ' active' : '';
      const params = new URLSearchParams();
      if (filterDomain) {
        params.set('domain', filterDomain);
      }
      if (filterSearch) {
        params.set('q', filterSearch);
      }
      params.set('page', number);
      const href = `/questions?${params.toString()}`;
      return `<li class="page-item${activeClass}"><a class="page-link" href="${escapeHtml(href)}">${number}</a></li>`;
    })
    .join('\n');
  const pagination =
    totalPages > 1
      ? `
        <nav aria-label="Question group pagination">
          <ul class="pagination justify-content-center">
            ${paginationItems}
          </ul>
        </nav>
      `
      : '';
  const totalLabel = `group${totalGroups === 1 ? '' : 's'}`;
  return `
    <div class="row justify-content-center">
      <div class="col-lg-10">
        <div class="card mb-3">
          <div class="card-body">
            <form id="exportForm" method="post" action="/questions/export"></form>
            <div class="d-flex flex-column flex-md-row justify-content-between align-items-md-center gap-3 mb-3">
              <div>
                <h5 class="card-title mb-1">Question Bank</h5>
                <p class="card-text mb-0">${hasGroups
                  ? `Showing ${escapeHtml(String(start))}–${escapeHtml(String(end))} of ${escapeHtml(String(totalGroups))} ${totalLabel}.`
                  : 'No question groups have been imported yet.'}</p>
              </div>
              <div class="d-flex gap-2 flex-wrap">
                <button type="submit" class="btn btn-outline-primary" form="exportForm" name="export_mode" value="selected">Export selected</button>
                <button type="submit" class="btn btn-outline-secondary" form="exportForm" name="export_mode" value="all">Export all</button>
                <button type="submit" class="btn btn-outline-danger" form="exportForm" formaction="/questions/delete-bulk" formmethod="post" data-bulk-delete disabled>Delete selected</button>
              </div>
            </div>
            <form class="row g-3 align-items-end mb-4" method="get" action="/questions">
              <div class="col-md-4">
                <label for="domain_filter" class="form-label">Domain</label>
                <select class="form-select" id="domain_filter" name="domain">
                  <option value="">All domains</option>
                  ${domainOptions}
                </select>
              </div>
              <div class="col-md-6">
                <label for="search_filter" class="form-label">Search</label>
                <input type="search" class="form-control" id="search_filter" name="q" value="${escapeHtml(filterSearch)}" placeholder="Search group context or question text">
              </div>
              <div class="col-md-2 d-flex gap-2">
                <button type="submit" class="btn btn-primary flex-grow-1">Filter</button>
                ${hasActiveFilters ? '<a class="btn btn-outline-secondary" href="/questions">Reset</a>' : ''}
              </div>
            </form>
            <div class="d-flex flex-wrap align-items-center gap-3 mb-2" role="group" aria-label="Group selection controls">
              <div class="form-check form-check-inline mb-0">
                <input type="checkbox" class="form-check-input" id="selection_scope_page" autocomplete="off" data-selection-control="page">
                <label class="form-check-label" for="selection_scope_page">Select current page</label>
              </div>
              <div class="form-check form-check-inline mb-0">
                <input type="checkbox" class="form-check-input" id="selection_scope_all" autocomplete="off" data-selection-control="all">
                <label class="form-check-label" for="selection_scope_all">Select all</label>
              </div>
            </div>
            <input type="hidden" name="selection_scope" value="page" form="exportForm" data-selection-scope-input>
            <div class="table-responsive" data-selection-root data-total-groups="${escapeHtml(String(totalGroups))}">
              <table class="table table-striped align-middle">
                <thead>
                  <tr>
                    <th scope="col" class="text-center" style="width: 3.5rem;">Select</th>
                    <th scope="col">Group details</th>
                    <th scope="col">Domain</th>
                    <th scope="col" class="text-center">Questions</th>
                    <th scope="col" class="text-nowrap">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  ${rows || '<tr><td colspan="5" class="text-center text-muted">No question groups imported yet.</td></tr>'}
                </tbody>
              </table>
            </div>
            <input type="hidden" name="select_all_pages" value="0" form="exportForm" data-select-all-input>
            <div class="alert alert-info mt-3 d-none" role="status" data-selection-notice>
              All ${escapeHtml(String(totalGroups))} groups matching the current filters are selected.
            </div>
            <input type="hidden" name="page" value="${escapeHtml(String(page))}" form="exportForm">
            ${filterDomain ? `<input type="hidden" name="domain" value="${escapeHtml(filterDomain)}" form="exportForm">` : ''}
            ${filterSearch ? `<input type="hidden" name="q" value="${escapeHtml(filterSearch)}" form="exportForm">` : ''}
            ${pagination}
          </div>
        </div>
      </div>
    </div>
    <script>
      document.addEventListener('DOMContentLoaded', () => {
        const selectionRoot = document.querySelector('[data-selection-root]');
        const itemCheckboxes = Array.from(document.querySelectorAll('[data-select-item]'));
        const selectionControls = Array.from(document.querySelectorAll('[data-selection-control]'));
        const selectAllPagesInput = document.querySelector('[data-select-all-input]');
        const selectionScopeInput = document.querySelector('[data-selection-scope-input]');
        const selectionNotice = document.querySelector('[data-selection-notice]');
        const bulkDeleteButton = document.querySelector('[data-bulk-delete]');
        const totalGroups = selectionRoot
          ? Number.parseInt(selectionRoot.getAttribute('data-total-groups') || '0', 10)
          : 0;
        const bulkDeleteLabelBase = bulkDeleteButton ? bulkDeleteButton.textContent.trim() || 'Delete selected' : 'Delete selected';
        const controlPage = selectionControls.find((control) => control.getAttribute('data-selection-control') === 'page');
        const controlAll = selectionControls.find((control) => control.getAttribute('data-selection-control') === 'all');
        const isAllScopeActive = () => selectAllPagesInput && selectAllPagesInput.value === '1';
        const getSelectedCount = () => {
          if (isAllScopeActive()) {
            return totalGroups;
          }
          return itemCheckboxes.filter((checkbox) => checkbox.checked).length;
        };
        const setScopeValue = (value) => {
          if (selectionScopeInput) {
            selectionScopeInput.value = value;
          }
        };
        const ensureControlsAvailability = () => {
          const hasItems = itemCheckboxes.length > 0;
          selectionControls.forEach((control) => {
            control.disabled = !hasItems;
            if (!hasItems) {
              control.checked = false;
            }
          });
          if (!hasItems && selectAllPagesInput) {
            selectAllPagesInput.value = '0';
          }
          if (!hasItems) {
            setScopeValue('page');
          }
        };
        const updateControlsFromState = () => {
          const hasItems = itemCheckboxes.length > 0;
          if (!hasItems) {
            return;
          }
          if (isAllScopeActive()) {
            setScopeValue('all');
            if (controlAll) {
              controlAll.checked = true;
            }
            if (controlPage) {
              controlPage.checked = false;
            }
            return;
          }
          setScopeValue('page');
          const total = itemCheckboxes.length;
          const checkedCount = itemCheckboxes.filter((checkbox) => checkbox.checked).length;
          if (controlAll) {
            controlAll.checked = false;
          }
          if (controlPage) {
            controlPage.checked = checkedCount === total && total > 0;
          }
        };
        const updateNotice = () => {
          if (!selectionNotice) {
            return;
          }
          if (isAllScopeActive() && totalGroups > 0) {
            selectionNotice.textContent =
              totalGroups === 1
                ? 'All 1 group matching the current filters is selected.'
                : 'All ' + totalGroups + ' groups matching the current filters are selected.';
            selectionNotice.classList.remove('d-none');
          } else {
            selectionNotice.classList.add('d-none');
          }
        };
        const updateBulkDeleteState = () => {
          if (!bulkDeleteButton) {
            return;
          }
          const hasItems = itemCheckboxes.length > 0;
          if (!hasItems) {
            bulkDeleteButton.disabled = true;
            bulkDeleteButton.textContent = bulkDeleteLabelBase;
            return;
          }
          const selectedCount = getSelectedCount();
          bulkDeleteButton.disabled = selectedCount === 0;
          if (selectedCount > 0) {
            bulkDeleteButton.textContent = bulkDeleteLabelBase + ' (' + selectedCount + ')';
          } else {
            bulkDeleteButton.textContent = bulkDeleteLabelBase;
          }
        };
        const updateState = () => {
          updateControlsFromState();
          updateNotice();
          updateBulkDeleteState();
        };
        ensureControlsAvailability();
        updateState();
        selectionControls.forEach((control) => {
          control.addEventListener('change', () => {
            if (control.disabled) {
              return;
            }
            const type = control.getAttribute('data-selection-control');
            const isChecked = control.checked;
            if (type === 'all') {
              if (selectAllPagesInput) {
                selectAllPagesInput.value = isChecked ? '1' : '0';
              }
              if (controlPage && isChecked) {
                controlPage.checked = false;
              }
              setScopeValue(isChecked ? 'all' : 'page');
            } else {
              if (selectAllPagesInput) {
                selectAllPagesInput.value = '0';
              }
              if (controlAll && isChecked) {
                controlAll.checked = false;
              }
              setScopeValue('page');
            }
            if (isChecked) {
              itemCheckboxes.forEach((checkbox) => {
                checkbox.checked = true;
              });
            } else {
              itemCheckboxes.forEach((checkbox) => {
                checkbox.checked = false;
              });
            }
            updateState();
          });
        });
        itemCheckboxes.forEach((checkbox) => {
          checkbox.addEventListener('change', () => {
            if (selectAllPagesInput && selectAllPagesInput.value === '1' && !checkbox.checked) {
              selectAllPagesInput.value = '0';
              setScopeValue('page');
            }
            updateState();
          });
        });
        const exportForm = document.getElementById('exportForm');
        if (exportForm) {
          exportForm.addEventListener('submit', (event) => {
            const submitter = event.submitter;
            const usingAllScope = isAllScopeActive();
            const hasPageSelection = itemCheckboxes.some((checkbox) => checkbox.checked);
            const selectedCount = getSelectedCount();
            if (submitter && submitter.matches('[data-bulk-delete]')) {
              if (!usingAllScope && !hasPageSelection) {
                event.preventDefault();
                window.alert('Select at least one group to delete.');
                return;
              }
              if (usingAllScope && totalGroups === 0) {
                event.preventDefault();
                window.alert('No groups match the current filters to delete.');
                return;
              }
              const countText = selectedCount === 1 ? '1 group' : selectedCount + ' groups';
              const message = usingAllScope
                ? 'Delete all ' + countText + ' that match the current filters? This action cannot be undone.'
                : 'Delete the selected ' + countText + '? This action cannot be undone.';
              if (!window.confirm(message)) {
                event.preventDefault();
                return;
              }
            }
            if (
              submitter &&
              submitter.name === 'export_mode' &&
              submitter.value === 'selected' &&
              !usingAllScope &&
              !hasPageSelection
            ) {
              event.preventDefault();
              window.alert('Select at least one group before exporting.');
            }
          });
        }
        updateState();
      });
    </script>
  `;
}

function renderQuestionGroupView({ group }) {
  const groupId = group && group.id ? String(group.id) : '';
  const disabledAttr = groupId ? '' : ' disabled';
  const questionCards = Array.isArray(group.questions)
    ? group.questions
        .map((question, index) => {
          const choices = Array.isArray(question.choices)
            ? question.choices
                .map(
                  (choice, choiceIndex) => `
                    <li class="list-group-item">
                      <strong>${String.fromCharCode(65 + choiceIndex)}.</strong> ${escapeHtml(choice)}
                    </li>
                  `,
                )
                .join('\n')
            : '';
          const correctAnswers = Array.isArray(question.correct_answers)
            ? question.correct_answers
                .map((answerIndex) => String.fromCharCode(65 + answerIndex))
                .join(', ')
            : '';
          const explanation = question.explanation || question.comment || '';
          return `
            <div class="card mb-3">
              <div class="card-body">
                <div class="d-flex justify-content-between align-items-start mb-2">
                  <h6 class="card-title mb-0">Question ${index + 1}</h6>
                  <span class="badge bg-secondary">${escapeHtml(question.id)}</span>
                </div>
                <p class="fw-semibold">${escapeHtml(question.question)}</p>
                <ul class="list-group list-group-flush mb-3 small">
                  ${choices}
                </ul>
                <p class="small mb-2"><strong>Correct:</strong> ${correctAnswers ? escapeHtml(correctAnswers) : 'N/A'}</p>
                ${explanation ? `<p class="small mb-3"><strong>Explanation:</strong> ${escapeHtml(explanation)}</p>` : ''}
                <div class="d-flex gap-2 flex-wrap">
                  <a class="btn btn-sm btn-outline-secondary" href="/questions/view?id=${encodeURIComponent(question.id)}">View question</a>
                  <a class="btn btn-sm btn-outline-primary" href="/questions/edit?id=${encodeURIComponent(question.id)}">Edit question</a>
                </div>
              </div>
            </div>
          `;
        })
        .join('\n')
    : '<p class="text-muted">No questions found in this group.</p>';
  const contextForm = `
    <form method="post" action="/questions/update-group-context" class="mb-4">
      <input type="hidden" name="id" value="${escapeHtml(groupId)}">
      <div class="mb-3">
        <label for="group_context" class="form-label">Shared context</label>
        <textarea class="form-control" id="group_context" name="context" rows="4" placeholder="Enter context for this group"${disabledAttr}>${escapeHtml(group.context || '')}</textarea>
        <div class="form-text">Shared stem or background information applied to all questions in this group.</div>
      </div>
      <button type="submit" class="btn btn-primary"${disabledAttr}>Save context</button>
      ${groupId ? '' : '<p class="form-text text-danger mt-2">Cannot update context because this group is missing an identifier.</p>'}
    </form>
  `;
  return `
    <div class="row justify-content-center">
      <div class="col-lg-10">
        <div class="card mb-3">
          <div class="card-body">
            <h5 class="card-title">${escapeHtml(group.id || 'Question group')}</h5>
            <p class="mb-2"><strong>Domain:</strong> ${escapeHtml(group.domain || 'General')}</p>
            ${contextForm}
            <p class="mb-4"><strong>Questions:</strong> ${escapeHtml(String((group.questions || []).length))}</p>
            ${questionCards}
            <a class="btn btn-secondary" href="/questions">Back to question bank</a>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderQuestionView({ question }) {
  const correctAnswers = Array.isArray(question.correct_answers) ? question.correct_answers : [];
  const choices = Array.isArray(question.choices) ? question.choices : [];
  const answerLabels = correctAnswers
    .map((index) => {
      const letter = String.fromCharCode(65 + index);
      const choice = choices[index];
      return `<li class="list-group-item"><strong>${escapeHtml(letter)}.</strong> ${escapeHtml(choice || '')}</li>`;
    })
    .join('\n');
  const choiceItems = choices
    .map((choice, index) => `<li class="list-group-item"><strong>${String.fromCharCode(65 + index)}.</strong> ${escapeHtml(choice)}</li>`)
    .join('\n');
  const contextSection = question.group_context
    ? `<p><strong>Context:</strong> ${escapeHtml(question.group_context)}</p>`
    : '';
  const explanationText = question.explanation || question.comment || '';
  return `
    <div class="row justify-content-center">
      <div class="col-lg-8">
        <div class="card mb-3">
          <div class="card-body">
            <h5 class="card-title">${escapeHtml(question.question)}</h5>
            <p><strong>Domain:</strong> ${escapeHtml(question.domain)}</p>
            ${contextSection}
            ${explanationText
              ? `<p><strong>Explanation:</strong> ${escapeHtml(explanationText)}</p>`
              : '<p class="text-muted">No explanation provided.</p>'}
            <h6>Choices</h6>
            <ul class="list-group list-group-flush mb-3">
              ${choiceItems}
            </ul>
            <h6>Correct Answers</h6>
            <ul class="list-group list-group-flush mb-3">
              ${answerLabels}
            </ul>
            <div class="d-flex gap-2">
              <a class="btn btn-outline-primary" href="/questions/edit?id=${encodeURIComponent(question.id)}">Edit</a>
              <a class="btn btn-secondary" href="/questions">Back to list</a>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderQuestionForm({ question, errors, domainOptions }) {
  const errorAlert = (errors && errors.length)
    ? `
        <div class="alert alert-danger" role="alert">
          <ul class="mb-0">
            ${errors.map((error) => `<li>${escapeHtml(error)}</li>`).join('\n')}
          </ul>
        </div>
      `
    : '';
  const choicesArray = Array.isArray(question.choices) ? question.choices : [];
  const choicesText =
    question.raw_choices !== undefined ? question.raw_choices : choicesArray.join('\n');
  const correctAnswersValue =
    question.raw_correct_answers !== undefined
      ? question.raw_correct_answers
      : (Array.isArray(question.correct_answers) ? question.correct_answers : [])
          .map((index) => String.fromCharCode(65 + index))
          .join(', ');
  const explanationValue =
    question.raw_comment !== undefined
      ? question.raw_comment
      : (question.explanation !== undefined && question.explanation !== null
          ? question.explanation
          : question.comment || '');
  const contextValue =
    question.raw_context !== undefined ? question.raw_context : question.group_context || '';
  const availableDomains = Array.isArray(domainOptions) && domainOptions.length ? domainOptions : DOMAIN_OPTIONS;
  const currentDomain = question.domain || '';
  const domainOptionsHtml = availableDomains
    .map((domain) => {
      const selected = domain === currentDomain ? ' selected' : '';
      return `<option value="${escapeHtml(domain)}"${selected}>${escapeHtml(domain)}</option>`;
    })
    .join('\n');
  const placeholderSelected = currentDomain && availableDomains.includes(currentDomain) ? '' : ' selected';
  return `
    <div class="row justify-content-center">
      <div class="col-lg-8">
        <div class="card">
          <div class="card-body">
            <h5 class="card-title">Edit question</h5>
            <p class="card-text">Update the question text, domain, choices, and correct answers. Enter one choice per line and identify correct answers using letters or indices (for example, <code>A</code> or <code>0</code>).</p>
            ${errorAlert}
            <form method="post" action="/questions/edit">
              <input type="hidden" name="id" value="${escapeHtml(question.id)}">
              <div class="mb-3">
                <label for="question_text" class="form-label">Question</label>
                <textarea class="form-control" id="question_text" name="question_text" rows="3" required>${escapeHtml(question.question)}</textarea>
              </div>
              <div class="mb-3">
                <label for="domain" class="form-label">Domain</label>
                <select class="form-select" id="domain" name="domain" required>
                  <option value="" disabled${placeholderSelected}>Select a domain</option>
                  ${domainOptionsHtml}
                </select>
              </div>
              <div class="mb-3">
                <label for="context" class="form-label">Context <span class="text-muted">(optional)</span></label>
                <textarea class="form-control" id="context" name="context" rows="3">${escapeHtml(contextValue)}</textarea>
                <div class="form-text">Shared stem or background information applied to all questions in this group.</div>
              </div>
              <div class="mb-3">
                <label for="choices" class="form-label">Choices <span class="text-muted">(one per line)</span></label>
                <textarea class="form-control" id="choices" name="choices" rows="6" required>${escapeHtml(choicesText)}</textarea>
              </div>
              <div class="mb-3">
                <label for="correct_answers" class="form-label">Correct Answers</label>
                <input type="text" class="form-control" id="correct_answers" name="correct_answers" value="${escapeHtml(correctAnswersValue)}" required>
                <div class="form-text">Use letters (A, B, C) or indices (0, 1, 2). Separate multiple answers with commas.</div>
              </div>
              <div class="mb-3">
                <label for="comment" class="form-label">Explanation <span class="text-muted">(optional)</span></label>
                <textarea class="form-control" id="comment" name="comment" rows="3">${escapeHtml(explanationValue)}</textarea>
              </div>
              <div class="d-flex gap-2">
                <button type="submit" class="btn btn-primary">Save Changes</button>
                <a class="btn btn-secondary" href="/questions/view?id=${encodeURIComponent(question.id)}">Cancel</a>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderNewTest({ groupCount, domains }) {
  const options = domains.map((domain) => `<option value="${escapeHtml(domain)}">${escapeHtml(domain)}</option>`).join('\n');
  const hasGroups = groupCount > 0;
  const defaultGroups = hasGroups ? Math.min(groupCount, 5) : 0;
  const minGroups = hasGroups ? 1 : 0;
  const maxGroups = hasGroups ? groupCount : 0;
  const inputValue = hasGroups ? defaultGroups : 0;
  const disabledAttr = hasGroups ? '' : ' disabled';
  const requiredAttr = hasGroups ? ' required' : '';
  return `
    <div class="row justify-content-center">
      <div class="col-lg-6">
        <div class="card">
          <div class="card-body">
            <h5 class="card-title">Create a practice test</h5>
            <p class="card-text">Select how many question groups to include and optionally filter by domain. Each group contributes all of its questions to the test.</p>
            <form method="post">
              <div class="mb-3">
                <label for="total_groups" class="form-label">Number of groups</label>
                <input type="number" class="form-control" id="total_groups" name="total_groups" min="${escapeHtml(String(minGroups))}" max="${escapeHtml(String(maxGroups))}" value="${escapeHtml(String(inputValue))}"${disabledAttr}${requiredAttr}>
                <div class="form-text">Maximum available groups for the chosen domain. All questions from each group are included.</div>
              </div>
              <div class="mb-3">
                <label for="domain" class="form-label">Domain</label>
                <select class="form-select" id="domain" name="domain">
                  <option value="">All domains</option>
                  ${options}
                </select>
              </div>
              <button type="submit" class="btn btn-success"${hasGroups ? '' : ' disabled'}>Start Test</button>
            </form>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderTest({ questions, mode }) {
  if (!questions.length) {
    return '<p class="text-muted">No questions available.</p>';
  }
  const formatContext = (value) => escapeHtml(value).replace(/\r?\n/g, '<br>');
  const groupMeta = new Map();
  questions.forEach((question) => {
    const key = question.group_id ? String(question.group_id) : `single-${question.id}`;
    const existing = groupMeta.get(key) || { count: 0, context: '' };
    existing.count += 1;
    const rawContext = typeof question.group_context === 'string' ? question.group_context.trim() : '';
    if (rawContext && !existing.context) {
      existing.context = rawContext;
    }
    groupMeta.set(key, existing);
  });
  const sections = [];
  let currentGroupKey = null;
  let currentSectionParts = [];
  let questionNumber = 0;
  questions.forEach((question) => {
    questionNumber += 1;
    const groupKey = question.group_id ? String(question.group_id) : `single-${question.id}`;
    if (groupKey !== currentGroupKey) {
      if (currentSectionParts.length) {
        sections.push(`<section class="mb-5">${currentSectionParts.join('\n')}</section>`);
      }
      currentSectionParts = [];
      currentGroupKey = groupKey;
      const meta = groupMeta.get(groupKey);
      if (meta && meta.context) {
        currentSectionParts.push(`
          <div class="alert alert-secondary" role="note">
            <p class="mb-2"><strong>背景描述：</strong>${formatContext(meta.context)}</p>
            <p class="mb-0">根据此背景描述回答下面${escapeHtml(String(meta.count))}题。</p>
          </div>
        `);
      }
    }
    const choiceItems = question.choices
      .map((choice, choiceIndex) => {
        const inputId = `${question.id}-${choiceIndex}`;
        return `
          <div class="form-check">
            <input class="form-check-input" type="checkbox" value="${choiceIndex}" id="${escapeHtml(inputId)}" name="q_${escapeHtml(question.id)}">
            <label class="form-check-label" for="${escapeHtml(inputId)}">
              ${escapeHtml(choice)}
            </label>
          </div>
        `;
      })
      .join('\n');
    currentSectionParts.push(`
      <div class="card mb-3">
        <div class="card-body">
          <fieldset>
            <legend class="h6 card-title">${questionNumber}. ${escapeHtml(question.question)}</legend>
            <div class="mb-3">
              ${choiceItems}
            </div>
            <div class="form-text">Domain: ${escapeHtml(question.domain)}</div>
          </fieldset>
        </div>
      </div>
    `);
  });
  if (currentSectionParts.length) {
    sections.push(`<section class="mb-5">${currentSectionParts.join('\n')}</section>`);
  }
  const sectionContent = sections.join('\n');
  return `
    <div class="row justify-content-center">
      <div class="col-lg-10">
        <form method="post" action="/test/submit" class="card">
          <div class="card-body">
            <h5 class="card-title">${mode === 'review' ? 'Review Session' : 'Practice Test'}</h5>
            <p class="card-text">Select the best answer(s) for each question. Questions may have multiple correct answers.</p>
            ${sectionContent}
          </div>
          <div class="card-footer d-flex justify-content-between align-items-center">
            <span class="text-muted">Questions: ${questions.length}</span>
            <button type="submit" class="btn btn-primary">Submit Answers</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function renderResults({ results, score, correctCount, totalQuestions, mode }) {
  const rawScore = typeof score === 'number' ? score.toFixed(2) : String(score || '0');
  const displayScore = escapeHtml(rawScore);
  const resultCards = results
    .map((result, index) => {
      const question = result.question;
      const choiceItems = question.choices
        .map((choice, choiceIndex) => {
          const isCorrect = result.correct_answers.includes(choiceIndex);
          const isSelected = result.selected.includes(choiceIndex);
          let listClass = 'list-group-item d-flex justify-content-between align-items-center';
          if (isCorrect) {
            listClass += ' list-group-item-success';
          } else if (isSelected) {
            listClass += ' list-group-item-danger';
          }
          const badgeClass = isCorrect ? 'success' : isSelected ? 'danger' : 'secondary';
          let badgeLabel = 'Option';
          if (isCorrect && isSelected) {
            badgeLabel = 'Correct';
          } else if (isCorrect) {
            badgeLabel = 'Should select';
          } else if (isSelected) {
            badgeLabel = 'Your answer';
          }
          return `\
            <li class="${listClass}">\
              <span>${escapeHtml(choice)}</span>\
              <span class="badge bg-${badgeClass}">${badgeLabel}</span>\
            </li>\
          `;
        })
        .join('\n');
      return `\
        <div class="card mb-3 ${result.is_correct ? 'border-success' : 'border-danger'}">\
          <div class="card-body">\
            <h6 class="card-title">${index + 1}. ${escapeHtml(question.question)}</h6>\
            <ul class="list-group list-group-flush mb-3">\
              ${choiceItems}\
            </ul>\
            <p><strong>Domain:</strong> ${escapeHtml(question.domain)}</p>\
            ${question.group_context ? `<p><strong>Context:</strong> ${escapeHtml(question.group_context)}</p>` : ''}\
            ${question.explanation || question.comment ? `<p><strong>Explanation:</strong> ${escapeHtml(question.explanation || question.comment)}</p>` : ''}\
          </div>\
        </div>\
      `;
    })
    .join('\n');
  return `
    <div class="row justify-content-center">
      <div class="col-lg-10">
        <div class="card mb-4">
          <div class="card-body d-flex flex-column flex-md-row justify-content-between align-items-md-center">
            <div>
              <h5 class="card-title mb-0">${mode === 'review' ? 'Review Session Results' : 'Practice Test Results'}</h5>
              <p class="card-text mb-0">You answered ${escapeHtml(correctCount)} out of ${escapeHtml(totalQuestions)} correctly.</p>
            </div>
            <div class="text-center mt-3 mt-md-0">
              <span class="display-6">${displayScore}%</span>
              <div class="text-muted">Score</div>
            </div>
          </div>
          <div class="card-footer d-flex gap-2 flex-wrap">
            <a class="btn btn-outline-primary" href="/test/new">Start Another Test</a>
            <a class="btn btn-outline-warning" href="/review">Review Mistakes</a>
            <a class="btn btn-secondary" href="/">Back to Dashboard</a>
          </div>
        </div>
        ${resultCards}
      </div>
    </div>
  `;
}

function renderReview({ reviewQuestions, wrongLookup }) {
  if (!reviewQuestions.length) {
    return `
      <div class="row justify-content-center">
        <div class="col-lg-8">
          <div class="card">
            <div class="card-body">
              <h5 class="card-title">Review questions answered incorrectly</h5>
              <p class="card-text text-muted">No questions have been marked incorrect yet. Complete a practice test to begin building your review set.</p>
            </div>
          </div>
        </div>
      </div>
    `;
  }
  const rows = reviewQuestions
    .map((question) => {
      const stats = wrongLookup[question.id] || {};
      return `\
        <tr>\
          <td>${escapeHtml(question.question)}</td>\
          <td>${escapeHtml(question.domain)}</td>\
          <td>${escapeHtml(stats.wrong_count || 0)}</td>\
          <td>${escapeHtml(stats.last_attempt || 'N/A')}</td>\
        </tr>\
      `;
    })
    .join('\n');
  return `
    <div class="row justify-content-center">
      <div class="col-lg-8">
        <div class="card">
          <div class="card-body">
            <h5 class="card-title">Review questions answered incorrectly</h5>
            <p class="card-text">You have ${reviewQuestions.length} question(s) flagged for review. Create a focused session to revisit them.</p>
            <form method="post" class="row g-3 align-items-center">
              <div class="col-sm-4">
                <label for="total_questions" class="col-form-label">Questions to review</label>
              </div>
              <div class="col-sm-4">
                <input type="number" class="form-control" id="total_questions" name="total_questions" min="1" max="${reviewQuestions.length}" value="${reviewQuestions.length}" required>
              </div>
              <div class="col-sm-4 d-grid">
                <button type="submit" class="btn btn-warning">Start Review</button>
              </div>
            </form>
            <hr>
            <div class="table-responsive">
              <table class="table table-sm align-middle">
                <thead>
                  <tr>
                    <th scope="col">Question</th>
                    <th scope="col">Domain</th>
                    <th scope="col">Times Missed</th>
                    <th scope="col">Last Attempt (UTC)</th>
                  </tr>
                </thead>
                <tbody>${rows}</tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderNotFound() {
  return `
    <div class="row justify-content-center">
      <div class="col-lg-6">
        <div class="card">
          <div class="card-body text-center">
            <h5 class="card-title">Page not found</h5>
            <p class="card-text">The requested page could not be located.</p>
            <a class="btn btn-primary" href="/">Return to dashboard</a>
          </div>
        </div>
      </div>
    </div>
  `;
}

function collectRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseMultipartFormData(bodyBuffer, boundary) {
  const result = { fields: new Map(), files: [] };
  if (!boundary) {
    return result;
  }
  const delimiter = `--${boundary}`;
  const bodyText = bodyBuffer.toString('utf8');
  const sections = bodyText.split(delimiter);
  for (const rawSection of sections) {
    if (!rawSection) {
      continue;
    }
    let section = rawSection;
    if (section.startsWith('\r\n')) {
      section = section.slice(2);
    }
    if (section === '--' || section === '--\r\n') {
      continue;
    }
    if (section.endsWith('\r\n')) {
      section = section.slice(0, -2);
    }
    const separatorIndex = section.indexOf('\r\n\r\n');
    if (separatorIndex === -1) {
      continue;
    }
    const headerPart = section.slice(0, separatorIndex);
    let valuePart = section.slice(separatorIndex + 4);
    if (valuePart.endsWith('\r\n')) {
      valuePart = valuePart.slice(0, -2);
    }
    const headers = headerPart.split('\r\n');
    const dispositionLine = headers.find((line) => /^content-disposition/i.test(line));
    if (!dispositionLine) {
      continue;
    }
    const nameMatch = dispositionLine.match(/name="([^"]+)"/i);
    if (!nameMatch) {
      continue;
    }
    const fieldName = nameMatch[1];
    const filenameMatch = dispositionLine.match(/filename="([^"]*)"/i);
    const contentTypeLine = headers.find((line) => /^content-type/i.test(line));
    const contentType = contentTypeLine ? contentTypeLine.split(':').slice(1).join(':').trim() : 'text/plain';
    if (filenameMatch && filenameMatch[1]) {
      result.files.push({
        name: fieldName,
        filename: filenameMatch[1],
        contentType,
        content: valuePart,
      });
    } else {
      result.fields.set(fieldName, valuePart);
    }
  }
  return result;
}

function addFlash(session, category, message) {
  if (!session.flash) {
    session.flash = [];
  }
  session.flash.push({ category, message });
}

function takeRandomSample(items, count) {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, count);
}

const server = http.createServer(async (req, res) => {
  try {
    const session = getSession(req, res);
    const flashMessages = session.flash ? session.flash.slice() : [];
    session.flash = [];

    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = requestUrl.pathname;

    if (req.method === 'GET' && pathname.startsWith('/static/')) {
      const staticPath = path.join(BASE_DIR, pathname);
      if (!staticPath.startsWith(path.join(BASE_DIR, 'static'))) {
        const { questionCount, domains } = loadQuestionContext();
        sendHtml(res, renderLayout({
          title: 'Not found',
          questionCount,
          wrongCount: loadWrongAnswers().length,
          domains,
          flashMessages,
          body: renderNotFound(),
        }), 404);
        return;
      }
      fs.readFile(staticPath, (error, data) => {
        if (error) {
          res.statusCode = 404;
          res.end('Not found');
          return;
        }
        const ext = path.extname(staticPath).toLowerCase();
        const types = {
          '.css': 'text/css',
          '.js': 'application/javascript',
          '.json': 'application/json',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.svg': 'image/svg+xml',
        };
        res.statusCode = 200;
        res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
        res.end(data);
      });
      return;
    }

    const { bank, questions, groups, domains, questionCount, groupCount } = loadQuestionContext();
    const wrongAnswers = loadWrongAnswers();

    if (pathname === '/questions' && req.method === 'GET') {
      const perPage = 10;
      const domainFilter = (requestUrl.searchParams.get('domain') || '').trim();
      const searchFilter = (requestUrl.searchParams.get('q') || '').trim();
      const filtered = filterGroupsByParams(groups, domainFilter, searchFilter);
      const totalGroups = filtered.length;
      const totalPages = Math.max(1, Math.ceil(Math.max(totalGroups, 1) / perPage));
      const requestedPage = Number.parseInt(requestUrl.searchParams.get('page') || '1', 10);
      const page = Number.isFinite(requestedPage) && requestedPage >= 1 ? Math.min(requestedPage, totalPages) : 1;
      const startIndex = (page - 1) * perPage;
      const pageItems = filtered.slice(startIndex, startIndex + perPage);
      const body = renderQuestionList({
        groups: pageItems,
        page,
        totalPages,
        perPage,
        totalGroups,
        filters: { domain: domainFilter, search: searchFilter },
        availableDomains: domains,
      });
      sendHtml(
        res,
        renderLayout({
          title: 'Question Bank · CISSP Test Simulator',
          questionCount,
          wrongCount: wrongAnswers.length,
          domains,
          flashMessages,
          body,
        }),
      );
      return;
    }

    if (pathname === '/questions/export' && req.method === 'POST') {
      const bodyBuffer = await collectRequestBody(req);
      const formData = new URLSearchParams(bodyBuffer.toString());
      const exportMode = formData.get('export_mode') || 'selected';
      const pageParam = Number.parseInt(formData.get('page') || '1', 10);
      const domainFilter = (formData.get('domain') || '').trim();
      const searchFilter = (formData.get('q') || '').trim();
      const selectionScope = formData.get('selection_scope') || 'page';
      const selectAllPages = formData.get('select_all_pages') === '1';
      const redirectUrl = buildQuestionRedirectUrl(pageParam, domainFilter, searchFilter);
      const selectedIds = formData.getAll('selected').filter((value) => value);
      let exportIds = null;
      if (exportMode === 'selected') {
        let selectedGroups = [];
        if (selectionScope === 'all' && selectAllPages) {
          selectedGroups = filterGroupsByParams(groups, domainFilter, searchFilter);
          if (!selectedGroups.length) {
            addFlash(session, 'warning', 'No question groups match the current filters to export.');
            redirect(res, redirectUrl);
            return;
          }
        } else {
          if (!selectedIds.length) {
            addFlash(session, 'warning', 'Select at least one question group to export or choose “Export all”.');
            redirect(res, redirectUrl);
            return;
          }
          const idSet = new Set(selectedIds);
          selectedGroups = groups.filter((group) => idSet.has(group.id));
          if (!selectedGroups.length) {
            addFlash(session, 'warning', 'No matching question groups were found for the selected items.');
            redirect(res, redirectUrl);
            return;
          }
        }
        exportIds = selectedGroups.map((group) => group.id);
      }
      const exportPayload = buildExportPayload(bank, exportIds);
      const payload = JSON.stringify(exportPayload, null, 2);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="questions_export.json"');
      res.end(payload);
      return;
    }

    if (pathname === '/questions/view-group' && req.method === 'GET') {
      const id = requestUrl.searchParams.get('id') || '';
      const group = groups.find((item) => item.id === id);
      if (!group) {
        addFlash(session, 'warning', 'Question group not found.');
        redirect(res, '/questions');
        return;
      }
      const body = renderQuestionGroupView({ group });
      sendHtml(
        res,
        renderLayout({
          title: 'View Question Group · CISSP Test Simulator',
          questionCount,
          wrongCount: wrongAnswers.length,
          domains,
          flashMessages,
          body,
        }),
      );
      return;
    }

    if (pathname === '/questions/update-group-context' && req.method === 'POST') {
      const bodyBuffer = await collectRequestBody(req);
      const formData = new URLSearchParams(bodyBuffer.toString());
      const id = (formData.get('id') || '').trim();
      if (!id) {
        addFlash(session, 'warning', 'Question group not found.');
        redirect(res, '/questions');
        return;
      }
      const contextInput = formData.get('context') || '';
      const contextValue = contextInput.toString().replace(/\r\n/g, '\n').trim();
      const targetGroup = Array.isArray(bank.groups)
        ? bank.groups.find((group) => group && String(group.id) === id)
        : null;
      if (!targetGroup) {
        addFlash(session, 'warning', 'Question group not found.');
        redirect(res, '/questions');
        return;
      }
      targetGroup.context = contextValue;
      saveQuestionBank(bank);
      addFlash(session, 'success', 'Group context updated successfully.');
      redirect(res, `/questions/view-group?id=${encodeURIComponent(id)}`);
      return;
    }

    if (pathname === '/questions/view' && req.method === 'GET') {
      const id = requestUrl.searchParams.get('id') || '';
      const question = questions.find((item) => item.id === id);
      if (!question) {
        addFlash(session, 'warning', 'Question not found.');
        redirect(res, '/questions');
        return;
      }
      const body = renderQuestionView({ question });
      sendHtml(
        res,
        renderLayout({
          title: 'View Question · CISSP Test Simulator',
          questionCount,
          wrongCount: wrongAnswers.length,
          domains,
          flashMessages,
          body,
        }),
      );
      return;
    }

    if (pathname === '/questions/edit' && req.method === 'GET') {
      const id = requestUrl.searchParams.get('id') || '';
      const question = questions.find((item) => item.id === id);
      if (!question) {
        addFlash(session, 'warning', 'Question not found.');
        redirect(res, '/questions');
        return;
      }
      const body = renderQuestionForm({ question, errors: [], domainOptions: DOMAIN_OPTIONS });
      sendHtml(
        res,
        renderLayout({
          title: 'Edit Question · CISSP Test Simulator',
          questionCount,
          wrongCount: wrongAnswers.length,
          domains,
          flashMessages,
          body,
        }),
      );
      return;
    }

    if (pathname === '/questions/edit' && req.method === 'POST') {
      const bodyBuffer = await collectRequestBody(req);
      const formData = new URLSearchParams(bodyBuffer.toString());
      const id = formData.get('id') || '';
      const index = questions.findIndex((item) => item.id === id);
      if (index === -1) {
        addFlash(session, 'warning', 'Question not found.');
        redirect(res, '/questions');
        return;
      }
      const location = findQuestionLocation(bank, id);
      if (!location) {
        addFlash(session, 'warning', 'Question not found.');
        redirect(res, '/questions');
        return;
      }
      const questionText = (formData.get('question_text') || '').trim();
      const domainInput = (formData.get('domain') || '').trim();
      const domain = DOMAIN_OPTIONS.includes(domainInput) ? domainInput : '';
      const choicesInput = formData.get('choices') || '';
      const choices = parseChoicesInput(choicesInput);
      const correctRawInput = formData.get('correct_answers') || '';
      const correctTokens = parseCorrectAnswersInput(correctRawInput);
      const normalizedCorrect = normalizeCorrectAnswers(correctTokens, choices);
      const contextInput = formData.get('context') || '';
      const contextValue = contextInput.toString().replace(/\r\n/g, '\n').trim();
      const commentInput = formData.get('comment') || '';
      const comment = commentInput.toString().replace(/\r\n/g, '\n').trim();
      const errors = [];
      if (!questionText) {
        errors.push('Question text is required.');
      }
      if (choices.length < 2) {
        errors.push('Provide at least two choices.');
      }
      if (!normalizedCorrect.length) {
        errors.push('Specify at least one correct answer.');
      }
      if (!domain) {
        errors.push('Select a domain from the list.');
      }
      if (errors.length) {
        const draft = {
          ...questions[index],
          question: questionText,
          domain: domainInput,
          choices,
          correct_answers: normalizedCorrect,
          comment,
          explanation: comment,
          group_context: contextValue,
          raw_choices: choicesInput,
          raw_correct_answers: correctRawInput,
          raw_context: contextInput,
          raw_comment: commentInput,
        };
        const body = renderQuestionForm({ question: draft, errors, domainOptions: DOMAIN_OPTIONS });
        sendHtml(
          res,
          renderLayout({
            title: 'Edit Question · CISSP Test Simulator',
            questionCount,
            wrongCount: wrongAnswers.length,
            domains,
            flashMessages,
            body,
          }),
        );
        return;
      }
      const targetGroup = bank.groups[location.groupIndex];
      if (!targetGroup || !Array.isArray(targetGroup.questions)) {
        addFlash(session, 'warning', 'Question not found.');
        redirect(res, '/questions');
        return;
      }
      targetGroup.domain = domain;
      targetGroup.context = contextValue;
      targetGroup.questions[location.questionIndex] = {
        ...targetGroup.questions[location.questionIndex],
        id,
        question: questionText,
        choices,
        correct_answers: normalizedCorrect,
        explanation: comment,
      };
      saveQuestionBank(removeEmptyGroups(bank));
      addFlash(session, 'success', 'Question updated successfully.');
      redirect(res, `/questions/view?id=${encodeURIComponent(id)}`);
      return;
    }

    if (pathname === '/questions/delete' && req.method === 'POST') {
      const bodyBuffer = await collectRequestBody(req);
      const formData = new URLSearchParams(bodyBuffer.toString());
      const id = formData.get('id') || '';
      const pageParam = Number.parseInt(formData.get('page') || '1', 10);
      const page = Number.isFinite(pageParam) && pageParam >= 1 ? pageParam : 1;
      const location = findQuestionLocation(bank, id);
      if (!location) {
        addFlash(session, 'warning', 'Question not found.');
        redirect(res, `/questions?page=${page}`);
        return;
      }
      const targetGroup = bank.groups[location.groupIndex];
      if (targetGroup && Array.isArray(targetGroup.questions)) {
        targetGroup.questions.splice(location.questionIndex, 1);
      }
      saveQuestionBank(removeEmptyGroups(bank));
      let wrongModified = false;
      for (let i = wrongAnswers.length - 1; i >= 0; i -= 1) {
        if (wrongAnswers[i] && wrongAnswers[i].question_id === id) {
          wrongAnswers.splice(i, 1);
          wrongModified = true;
        }
      }
      if (wrongModified) {
        saveWrongAnswers(wrongAnswers);
      }
      addFlash(session, 'success', 'Question deleted.');
      redirect(res, `/questions?page=${page}`);
      return;
    }

    if (pathname === '/questions/delete-bulk' && req.method === 'POST') {
      const bodyBuffer = await collectRequestBody(req);
      const formData = new URLSearchParams(bodyBuffer.toString());
      const selectedIds = formData.getAll('selected').filter((value) => value);
      const pageParam = Number.parseInt(formData.get('page') || '1', 10);
      const page = Number.isFinite(pageParam) && pageParam >= 1 ? pageParam : 1;
      const domainFilter = (formData.get('domain') || '').trim();
      const searchFilter = (formData.get('q') || '').trim();
      const selectionScope = formData.get('selection_scope') || 'page';
      const selectAllPages = formData.get('select_all_pages') === '1';
      const redirectUrl = buildQuestionRedirectUrl(page, domainFilter, searchFilter);
      if (selectionScope === 'all' && selectAllPages) {
        const filtered = filterGroupsByParams(groups, domainFilter, searchFilter);
        if (!filtered.length) {
          addFlash(session, 'warning', 'No question groups match the current filters to delete.');
          redirect(res, redirectUrl);
          return;
        }
        const filteredIds = new Set(filtered.map((group) => group.id));
        const removedCount = removeGroupsById(bank, filteredIds);
        if (!removedCount) {
          addFlash(session, 'warning', 'No question groups match the current filters to delete.');
          redirect(res, redirectUrl);
          return;
        }
        const removedQuestionIds = collectGroupQuestionIds(filtered, filteredIds);
        const remainingWrongAnswers = wrongAnswers.filter((item) => !removedQuestionIds.has(item.question_id));
        if (remainingWrongAnswers.length !== wrongAnswers.length) {
          saveWrongAnswers(remainingWrongAnswers);
        }
        saveQuestionBank(bank);
        addFlash(
          session,
          'success',
          removedCount === 1 ? 'Deleted 1 group.' : `Deleted ${removedCount} groups.`,
        );
        redirect(res, redirectUrl);
        return;
      }
      if (!selectedIds.length) {
        addFlash(session, 'warning', 'Select at least one question group to delete.');
        redirect(res, redirectUrl);
        return;
      }
      const idSet = new Set(selectedIds);
      const removedCount = removeGroupsById(bank, idSet);
      if (removedCount === 0) {
        addFlash(session, 'warning', 'No matching question groups were found for the selected items.');
        redirect(res, redirectUrl);
        return;
      }
      const removedQuestionIds = collectGroupQuestionIds(groups, idSet);
      const remainingWrongAnswers = wrongAnswers.filter((item) => !removedQuestionIds.has(item.question_id));
      if (remainingWrongAnswers.length !== wrongAnswers.length) {
        saveWrongAnswers(remainingWrongAnswers);
      }
      saveQuestionBank(bank);
      addFlash(
        session,
        'success',
        removedCount === 1 ? 'Deleted 1 group.' : `Deleted ${removedCount} groups.`,
      );
      redirect(res, redirectUrl);
      return;
    }

    if (req.method === 'GET' && pathname === '/') {
      const wrongDetails = wrongAnswers.map((item) => ({
        ...item,
        question: questions.find((q) => q.id === item.question_id) || null,
      }));
      const body = renderIndex({
        questionCount,
        wrongCount: wrongAnswers.length,
        domains,
        wrongDetails,
      });
      sendHtml(
        res,
        renderLayout({
          title: 'Dashboard · CISSP Test Simulator',
          questionCount,
          wrongCount: wrongAnswers.length,
          domains,
          flashMessages,
          body,
        }),
      );
      return;
    }

    if (pathname === '/import') {
      redirect(res, '/import/json');
      return;
    }

    if (pathname === '/import/json') {
      if (req.method === 'GET') {
        const body = renderImportJson();
        sendHtml(
          res,
          renderLayout({
            title: 'Import JSON · CISSP Test Simulator',
            questionCount,
            wrongCount: wrongAnswers.length,
            domains,
            flashMessages,
            body,
          }),
        );
        return;
      }
      if (req.method === 'POST') {
        const bodyBuffer = await collectRequestBody(req);
        const contentType = req.headers['content-type'] || '';
        let payloadText = '';
        let textImport = '';
        let batchDomain = '';
        let customDomain = '';
        if (/^multipart\/form-data/i.test(contentType)) {
          const boundaryMatch = contentType.match(/boundary="?([^";]+)"?/i);
          const boundary = boundaryMatch ? boundaryMatch[1] : '';
          const parsed = parseMultipartFormData(bodyBuffer, boundary);
          const uploaded = parsed.files.find(
            (file) => file.name === 'questions_file' && typeof file.content === 'string' && file.content.trim(),
          );
          if (uploaded) {
            payloadText = uploaded.content;
          }
          if (!payloadText && parsed.fields.has('questions_json')) {
            payloadText = parsed.fields.get('questions_json') || '';
          }
          if (parsed.fields.has('questions_text')) {
            textImport = parsed.fields.get('questions_text') || '';
          }
          if (parsed.fields.has('batch_domain')) {
            batchDomain = parsed.fields.get('batch_domain') || '';
          }
          if (parsed.fields.has('custom_domain')) {
            customDomain = parsed.fields.get('custom_domain') || '';
          }
        } else {
          const formData = new URLSearchParams(bodyBuffer.toString());
          payloadText = formData.get('questions_json') || '';
          textImport = formData.get('questions_text') || '';
          batchDomain = formData.get('batch_domain') || '';
          customDomain = formData.get('custom_domain') || '';
        }
        const trimmedTextImport = (textImport || '').trim();
        if (trimmedTextImport) {
          try {
            const structuredDomain = resolveDomainInput(batchDomain, customDomain);
            const prepared = parseStructuredTextImport(trimmedTextImport, structuredDomain);
            const stats = importQuestions(prepared);
            addFlash(session, 'success', `Imported ${stats.imported} questions, updated ${stats.updated}.`);
            redirect(res, '/');
          } catch (error) {
            addFlash(session, 'danger', `Failed to import questions: ${error.message}`);
            redirect(res, '/import/json');
          }
          return;
        }
        const trimmedPayload = (payloadText || '').trim();
        if (!trimmedPayload) {
          addFlash(session, 'danger', 'Provide questions JSON by pasting data or uploading a file.');
          redirect(res, '/import/json');
          return;
        }
        try {
          const parsed = JSON.parse(trimmedPayload);
          const stats = importQuestions(parsed);
          addFlash(session, 'success', `Imported ${stats.imported} questions, updated ${stats.updated}.`);
          redirect(res, '/');
        } catch (error) {
          addFlash(session, 'danger', `Failed to import questions: ${error.message}`);
          redirect(res, '/import/json');
        }
        return;
      }
    }

    if (pathname === '/import/ai') {
      const qwenEnabled = Boolean(QWEN_API_KEY && QWEN_API_KEY.trim());
      if (req.method === 'GET') {
        const body = renderImportAi({
          domains,
          qwenEnabled,
        });
        sendHtml(
          res,
          renderLayout({
            title: 'AI Import (Qwen) · CISSP Test Simulator',
            questionCount,
            wrongCount: wrongAnswers.length,
            domains,
            flashMessages,
            body,
          }),
        );
        return;
      }
      if (req.method === 'POST') {
        const bodyBuffer = await collectRequestBody(req);
        const contentType = req.headers['content-type'] || '';
        let importMode = 'ai_prepare';
        let aiDomain = '';
        let aiCustomDomain = '';
        let aiSource = '';
        let aiPayload = '';
        let aiInstructions = '';
        if (/^multipart\/form-data/i.test(contentType)) {
          const boundaryMatch = contentType.match(/boundary="?([^";]+)"?/i);
          const boundary = boundaryMatch ? boundaryMatch[1] : '';
          const parsed = parseMultipartFormData(bodyBuffer, boundary);
          if (parsed.fields.has('import_mode')) {
            importMode = parsed.fields.get('import_mode') || 'ai_prepare';
          }
          if (parsed.fields.has('ai_domain')) {
            aiDomain = parsed.fields.get('ai_domain') || '';
          }
          if (parsed.fields.has('ai_custom_domain')) {
            aiCustomDomain = parsed.fields.get('ai_custom_domain') || '';
          }
          if (parsed.fields.has('ai_source')) {
            aiSource = parsed.fields.get('ai_source') || '';
          }
          if (parsed.fields.has('ai_payload')) {
            aiPayload = parsed.fields.get('ai_payload') || '';
          }
          if (parsed.fields.has('ai_instructions')) {
            aiInstructions = parsed.fields.get('ai_instructions') || '';
          }
        } else {
          const formData = new URLSearchParams(bodyBuffer.toString());
          importMode = formData.get('import_mode') || 'ai_prepare';
          aiDomain = formData.get('ai_domain') || '';
          aiCustomDomain = formData.get('ai_custom_domain') || '';
          aiSource = formData.get('ai_source') || '';
          aiPayload = formData.get('ai_payload') || '';
          aiInstructions = formData.get('ai_instructions') || '';
        }
        const trimmedAiSource = (aiSource || '').trim();
        const aiDomainValue = resolveDomainInput(aiDomain, aiCustomDomain, '');
        if (importMode === 'ai_confirm') {
          const trimmedPayload = (aiPayload || '').trim();
          if (!trimmedPayload) {
            addFlash(session, 'danger', 'The AI preview payload was missing. Please run the analysis again.');
            redirect(res, '/import/ai');
            return;
          }
          try {
            const parsed = JSON.parse(trimmedPayload);
            const stats = importQuestions(parsed);
            addFlash(session, 'success', `Imported ${stats.imported} questions, updated ${stats.updated}.`);
            redirect(res, '/');
          } catch (error) {
            addFlash(session, 'danger', `Failed to import AI results: ${error.message}`);
            redirect(res, '/import/ai');
          }
          return;
        }
        if (importMode === 'ai_prepare') {
          if (!qwenEnabled) {
            addFlash(session, 'danger', 'AI-assisted imports are disabled. Set the DASHSCOPE_API_KEY before running the analysis.');
            redirect(res, '/import/ai');
            return;
          }
          if (!trimmedAiSource) {
            addFlash(session, 'danger', 'Provide the raw questions and answers before running the AI import.');
            redirect(res, '/import/ai');
            return;
          }
          if (!aiDomainValue) {
            addFlash(session, 'danger', 'Select or enter a domain for the AI import.');
            redirect(res, '/import/ai');
            return;
          }
          try {
            const result = await prepareAiImportFromRaw(trimmedAiSource, aiDomainValue, aiInstructions);
            const aiSelectValue =
              aiDomain === '__custom__' || (!aiDomain && aiCustomDomain)
                ? '__custom__'
                : result.domain;
            const aiCustomValueForForm = aiSelectValue === '__custom__' ? result.domain : '';
            const previewBody = renderImportAi({
              domains,
              qwenEnabled,
              aiSelectedDomain: aiSelectValue,
              aiCustomDomain: aiCustomValueForForm,
              aiSourceText: trimmedAiSource,
              aiInstructionsText: aiInstructions,
              aiPreview: {
                domain: result.domain,
                groups: result.previewGroups,
                questionCount: result.questionCount,
                payload: JSON.stringify(result.importPayload, null, 2),
                source: trimmedAiSource,
              },
            });
            flashMessages.push({
              category: 'info',
              message: 'Review the extracted questions below before importing them.',
            });
            sendHtml(
              res,
              renderLayout({
                title: 'AI Import (Qwen) · CISSP Test Simulator',
                questionCount,
                wrongCount: wrongAnswers.length,
                domains,
                flashMessages,
                body: previewBody,
              }),
            );
          } catch (error) {
            addFlash(session, 'danger', `Failed to analyze questions with Qwen: ${error.message}`);
            redirect(res, '/import/ai');
          }
          return;
        }
        addFlash(session, 'danger', 'Unsupported AI import mode.');
        redirect(res, '/import/ai');
        return;
      }
    }

    if (pathname === '/test/new') {
      if (req.method === 'GET') {
        const body = renderNewTest({ groupCount, domains });
        sendHtml(
          res,
          renderLayout({
            title: 'New Test · CISSP Test Simulator',
            questionCount,
            wrongCount: wrongAnswers.length,
            domains,
            flashMessages,
            body,
          }),
        );
        return;
      }
      if (req.method === 'POST') {
        if (groupCount === 0) {
          addFlash(session, 'warning', 'Import questions before creating a test.');
          redirect(res, '/import/json');
          return;
        }
        const bodyBuffer = await collectRequestBody(req);
        const formData = new URLSearchParams(bodyBuffer.toString());
        const domain = formData.get('domain') || '';
        const filteredGroups = groups.filter((group) => !domain || group.domain === domain);
        if (!filteredGroups.length) {
          addFlash(session, 'warning', 'No question groups available for the selected criteria.');
          redirect(res, '/test/new');
          return;
        }
        const requested = Number.parseInt(formData.get('total_groups') || '0', 10);
        const totalGroups = Math.max(
          1,
          Math.min(Number.isFinite(requested) ? requested : filteredGroups.length, filteredGroups.length),
        );
        const selectedGroups = takeRandomSample(filteredGroups, totalGroups);
        const selectedQuestions = [];
        for (const group of selectedGroups) {
          if (!group || !Array.isArray(group.questions)) {
            continue;
          }
          for (const question of group.questions) {
            selectedQuestions.push({
              ...question,
            });
          }
        }
        if (!selectedQuestions.length) {
          addFlash(session, 'warning', 'The selected groups did not contain any questions.');
          redirect(res, '/test/new');
          return;
        }
        session.currentTest = {
          questions: selectedQuestions,
          timestamp: new Date().toISOString(),
          mode: 'standard',
        };
        redirect(res, '/test');
        return;
      }
    }

    if (pathname === '/test') {
      if (req.method === 'GET') {
        const currentTest = session.currentTest;
        if (!currentTest || !Array.isArray(currentTest.questions) || !currentTest.questions.length) {
          addFlash(session, 'info', 'Start a test to access this page.');
          redirect(res, '/test/new');
          return;
        }
        const body = renderTest({ questions: currentTest.questions, mode: currentTest.mode || 'standard' });
        sendHtml(
          res,
          renderLayout({
            title: 'Take Test · CISSP Test Simulator',
            questionCount,
            wrongCount: wrongAnswers.length,
            domains,
            flashMessages,
            body,
          }),
        );
        return;
      }
    }

    if (pathname === '/test/submit' && req.method === 'POST') {
      const currentTest = session.currentTest;
      if (!currentTest || !Array.isArray(currentTest.questions) || !currentTest.questions.length) {
        addFlash(session, 'warning', 'No active test found.');
        redirect(res, '/test/new');
        return;
      }
      const bodyBuffer = await collectRequestBody(req);
      const formData = new URLSearchParams(bodyBuffer.toString());
      const results = [];
      let correctCount = 0;
      for (const question of currentTest.questions) {
        const key = `q_${question.id}`;
        const selectedValues = formData.getAll(key).map((value) => Number.parseInt(value, 10)).filter((value) => Number.isInteger(value));
        const selected = Array.from(new Set(selectedValues)).sort((a, b) => a - b);
        const correctAnswers = Array.isArray(question.correct_answers) ? question.correct_answers.slice().sort((a, b) => a - b) : [];
        const isCorrect = selected.length === correctAnswers.length && selected.every((value, index) => value === correctAnswers[index]);
        if (isCorrect) {
          correctCount += 1;
        }
        updateWrongAnswers(question.id, selected, isCorrect);
        results.push({
          question,
          selected,
          is_correct: isCorrect,
          correct_answers: correctAnswers,
        });
      }
      const totalQuestions = currentTest.questions.length;
      const score = totalQuestions ? Math.round((correctCount / totalQuestions) * 10000) / 100 : 0;
      session.lastResults = {
        results,
        score,
        correctCount,
        totalQuestions,
        mode: currentTest.mode || 'standard',
      };
      delete session.currentTest;
      redirect(res, '/results');
      return;
    }

    if (pathname === '/results' && req.method === 'GET') {
      const lastResults = session.lastResults;
      if (!lastResults) {
        addFlash(session, 'info', 'No results to display.');
        redirect(res, '/');
        return;
      }
      const body = renderResults(lastResults);
      sendHtml(
        res,
        renderLayout({
          title: 'Results · CISSP Test Simulator',
          questionCount,
          wrongCount: wrongAnswers.length,
          domains,
          flashMessages,
          body,
        }),
      );
      delete session.lastResults;
      return;
    }

    if (pathname === '/review') {
      if (req.method === 'GET') {
        const wrongLookup = Object.fromEntries(wrongAnswers.map((item) => [item.question_id, item]));
        const reviewQuestions = questions.filter((question) => wrongLookup[question.id]);
        const body = renderReview({ reviewQuestions, wrongLookup });
        sendHtml(
          res,
          renderLayout({
            title: 'Review Mistakes · CISSP Test Simulator',
            questionCount,
            wrongCount: wrongAnswers.length,
            domains,
            flashMessages,
            body,
          }),
        );
        return;
      }
      if (req.method === 'POST') {
        const wrongLookup = Object.fromEntries(wrongAnswers.map((item) => [item.question_id, item]));
        const reviewQuestions = questions.filter((question) => wrongLookup[question.id]);
        if (!reviewQuestions.length) {
          addFlash(session, 'info', 'There are no questions to review right now.');
          redirect(res, '/review');
          return;
        }
        const bodyBuffer = await collectRequestBody(req);
        const formData = new URLSearchParams(bodyBuffer.toString());
        const requested = Number.parseInt(formData.get('total_questions') || '0', 10);
        const totalQuestions = Math.max(1, Math.min(Number.isFinite(requested) ? requested : reviewQuestions.length, reviewQuestions.length));
        const selected = takeRandomSample(reviewQuestions, totalQuestions);
        session.currentTest = {
          questions: selected,
          timestamp: new Date().toISOString(),
          mode: 'review',
        };
        redirect(res, '/test');
        return;
      }
    }

    sendHtml(
      res,
      renderLayout({
        title: 'Not found · CISSP Test Simulator',
        questionCount,
        wrongCount: wrongAnswers.length,
        domains,
        flashMessages,
        body: renderNotFound(),
      }),
      404,
    );
  } catch (error) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(`Internal Server Error: ${error.message}`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}/`);
});
