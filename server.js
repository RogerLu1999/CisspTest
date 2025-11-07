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

const DNS_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

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
  const questions = flattenQuestionBank(bank);
  const domains = Array.from(new Set(questions.map((question) => question.domain || 'General'))).sort();
  return {
    bank,
    questions,
    domains,
    questionCount: questions.length,
  };
}

function buildExportPayload(bank, selectedIds) {
  const includeAll = !selectedIds;
  const idSet = includeAll ? null : new Set(selectedIds.map((value) => String(value)));
  const groups = [];
  if (bank && Array.isArray(bank.groups)) {
    for (const group of bank.groups) {
      if (!group || !Array.isArray(group.questions)) {
        continue;
      }
      const filteredQuestions = group.questions
        .filter((question) => includeAll || (question && idSet && idSet.has(String(question.id))));
      if (!filteredQuestions.length) {
        continue;
      }
      const exportQuestions = filteredQuestions.map((question) => ({
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
        id: group.id ? String(group.id) : undefined,
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
              <a class="nav-link" href="/import">Import Questions</a>
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
              <a class="btn btn-primary" href="/import">Import Questions</a>
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

function renderImport() {
  return `
    <div class="row g-4">
      <div class="col-lg-6">
        <div class="card h-100">
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
      <div class="col-lg-6">
        <div class="card h-100">
          <div class="card-body">
            <h5 class="card-title">Import from structured text</h5>
            <p class="card-text">Provide a long passage that lists the questions first and an answer key afterwards. The importer matches answers by their number.</p>
            <form method="post">
              <div class="mb-3">
                <label for="batch_domain" class="form-label">Domain for this batch</label>
                <input type="text" class="form-control" id="batch_domain" name="batch_domain" placeholder="e.g. Security and Risk Management">
                <div class="form-text">The selected domain is applied to every question imported from this text.</div>
              </div>
              <div class="mb-3">
                <label for="questions_text" class="form-label">Questions &amp; Answers</label>
                <textarea class="form-control" id="questions_text" name="questions_text" rows="12" placeholder="1. ...\nA. ...\nB. ...\n...\nAnswers\n1. A Explanation: ..."></textarea>
                <div class="form-text">Include an <strong>Answers</strong> (or <strong>答案</strong>) heading followed by one line per question, each starting with its number and the correct option.</div>
              </div>
              <button type="submit" class="btn btn-primary">Import Structured Text</button>
            </form>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderQuestionList({
  questions,
  page,
  totalPages,
  perPage,
  totalQuestions,
  filters,
  availableDomains,
}) {
  const hasQuestions = totalQuestions > 0;
  const start = hasQuestions ? (page - 1) * perPage + 1 : 0;
  const end = hasQuestions ? Math.min(start + perPage - 1, totalQuestions) : 0;
  const filterDomain = filters.domain || '';
  const filterSearch = filters.search || '';
  const hasActiveFilters = Boolean(filterDomain || filterSearch);
  const domainOptions = availableDomains
    .map((domain) => {
      const selected = domain === filterDomain ? ' selected' : '';
      return `<option value="${escapeHtml(domain)}"${selected}>${escapeHtml(domain)}</option>`;
    })
    .join('\n');
  const rows = questions
    .map(
      (question) => `
        <tr>
          <td class="text-center">
            <input class="form-check-input" type="checkbox" name="selected" value="${escapeHtml(question.id)}" form="exportForm" aria-label="Select question" data-select-item>
          </td>
          <td>${escapeHtml(question.question)}</td>
          <td>${escapeHtml(question.domain)}</td>
          <td class="text-nowrap">
            <a class="btn btn-sm btn-outline-secondary" href="/questions/view?id=${encodeURIComponent(question.id)}">View</a>
            <a class="btn btn-sm btn-outline-primary" href="/questions/edit?id=${encodeURIComponent(question.id)}">Edit</a>
            <form class="d-inline" method="post" action="/questions/delete">
              <input type="hidden" name="id" value="${escapeHtml(question.id)}">
              <input type="hidden" name="page" value="${page}">
              <button type="submit" class="btn btn-sm btn-outline-danger" onclick="return confirm('Delete this question?');">Delete</button>
            </form>
          </td>
        </tr>
      `,
    )
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
        <nav aria-label="Question pagination">
          <ul class="pagination justify-content-center">
            ${paginationItems}
          </ul>
        </nav>
      `
      : '';
  return `
    <div class="row justify-content-center">
      <div class="col-lg-10">
        <div class="card mb-3">
          <div class="card-body">
            <form id="exportForm" method="post" action="/questions/export"></form>
            <div class="d-flex flex-column flex-md-row justify-content-between align-items-md-center gap-3 mb-3">
              <div>
                <h5 class="card-title mb-1">Question Bank</h5>
                <p class="card-text mb-0">${hasQuestions
                  ? `Showing ${escapeHtml(String(start))}–${escapeHtml(String(end))} of ${escapeHtml(String(totalQuestions))} questions.`
                  : 'No questions have been imported yet.'}</p>
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
                <input type="search" class="form-control" id="search_filter" name="q" value="${escapeHtml(filterSearch)}" placeholder="Search question text or explanation">
              </div>
              <div class="col-md-2 d-flex gap-2">
                <button type="submit" class="btn btn-primary flex-grow-1">Filter</button>
                ${hasActiveFilters ? '<a class="btn btn-outline-secondary" href="/questions">Reset</a>' : ''}
              </div>
            </form>
            <div class="d-flex flex-wrap align-items-center gap-3 mb-2" role="group" aria-label="Question selection controls">
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
            <div class="table-responsive" data-selection-root data-total-questions="${escapeHtml(String(totalQuestions))}">
              <table class="table table-striped align-middle">
                <thead>
                  <tr>
                    <th scope="col" class="text-center" style="width: 3.5rem;">Select</th>
                    <th scope="col">Question</th>
                    <th scope="col">Domain</th>
                    <th scope="col" class="text-nowrap">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  ${rows || '<tr><td colspan="4" class="text-center text-muted">No questions imported yet.</td></tr>'}
                </tbody>
              </table>
            </div>
            <input type="hidden" name="select_all_pages" value="0" form="exportForm" data-select-all-input>
            <div class="alert alert-info mt-3 d-none" role="status" data-selection-notice>
              All ${escapeHtml(String(totalQuestions))} questions matching the current filters are selected.
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
        const totalQuestions = selectionRoot
          ? Number.parseInt(selectionRoot.getAttribute('data-total-questions') || '0', 10)
          : 0;
        const bulkDeleteLabelBase = bulkDeleteButton ? bulkDeleteButton.textContent.trim() || 'Delete selected' : 'Delete selected';
        const controlPage = selectionControls.find((control) => control.getAttribute('data-selection-control') === 'page');
        const controlAll = selectionControls.find((control) => control.getAttribute('data-selection-control') === 'all');
        const isAllScopeActive = () => selectAllPagesInput && selectAllPagesInput.value === '1';
        const getSelectedCount = () => {
          if (isAllScopeActive()) {
            return totalQuestions;
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
          if (isAllScopeActive() && totalQuestions > 0) {
            selectionNotice.textContent =
              totalQuestions === 1
                ? 'All 1 question matching the current filters is selected.'
                : 'All ' + totalQuestions + ' questions matching the current filters are selected.';
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
                window.alert('Select at least one question to delete.');
                return;
              }
              if (usingAllScope && totalQuestions === 0) {
                event.preventDefault();
                window.alert('No questions match the current filters to delete.');
                return;
              }
              const countText = selectedCount === 1 ? '1 question' : selectedCount + ' questions';
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
              window.alert('Select at least one question before exporting.');
            }
          });
        }
        updateState();
      });
    </script>
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

function renderQuestionForm({ question, errors }) {
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
                <input type="text" class="form-control" id="domain" name="domain" value="${escapeHtml(question.domain)}" required>
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

function renderNewTest({ questionCount, domains }) {
  const options = domains.map((domain) => `<option value="${escapeHtml(domain)}">${escapeHtml(domain)}</option>`).join('\n');
  const defaultQuestions = questionCount === 0 ? 0 : Math.min(questionCount, 25);
  return `
    <div class="row justify-content-center">
      <div class="col-lg-6">
        <div class="card">
          <div class="card-body">
            <h5 class="card-title">Create a practice test</h5>
            <p class="card-text">Select the number of questions and optionally filter by domain. A random set of questions will be pulled from your local bank.</p>
            <form method="post">
              <div class="mb-3">
                <label for="total_questions" class="form-label">Number of questions</label>
                <input type="number" class="form-control" id="total_questions" name="total_questions" min="1" max="${escapeHtml(questionCount)}" value="${escapeHtml(defaultQuestions)}" required>
                <div class="form-text">Maximum available for the chosen domain.</div>
              </div>
              <div class="mb-3">
                <label for="domain" class="form-label">Domain</label>
                <select class="form-select" id="domain" name="domain">
                  <option value="">All domains</option>
                  ${options}
                </select>
              </div>
              <button type="submit" class="btn btn-success"${questionCount === 0 ? ' disabled' : ''}>Start Test</button>
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
  const accordionItems = questions
    .map((question, index) => {
      const choiceItems = question.choices
        .map(
          (choice, choiceIndex) => `\
            <div class="form-check">\
              <input class="form-check-input" type="checkbox" value="${choiceIndex}" id="${escapeHtml(question.id)}-${choiceIndex}" name="q_${escapeHtml(question.id)}">\
              <label class="form-check-label" for="${escapeHtml(question.id)}-${choiceIndex}">\
                ${escapeHtml(choice)}\
              </label>\
            </div>\
          `,
        )
        .join('\n');
      return `\
        <div class="accordion-item">\
          <h2 class="accordion-header" id="heading-${index + 1}">\
            <button class="accordion-button${index === 0 ? '' : ' collapsed'}" type="button" data-bs-toggle="collapse" data-bs-target="#collapse-${index + 1}" aria-expanded="${index === 0}" aria-controls="collapse-${index + 1}">\
              <span class="badge bg-secondary me-2">${index + 1}</span>\
              <span>${escapeHtml(question.question)}</span>\
            </button>\
          </h2>\
          <div id="collapse-${index + 1}" class="accordion-collapse collapse${index === 0 ? ' show' : ''}" aria-labelledby="heading-${index + 1}" data-bs-parent="#testAccordion">\
            <div class="accordion-body">\
              <fieldset>\
                <legend class="visually-hidden">Question ${index + 1}</legend>\
                ${question.group_context
                  ? `<p class="mb-3"><strong>Context:</strong> ${escapeHtml(question.group_context)}</p>`
                  : ''}\
                ${choiceItems}\
                <div class="form-text">Domain: ${escapeHtml(question.domain)}</div>\
              </fieldset>\
            </div>\
          </div>\
        </div>\
      `;
    })
    .join('\n');
  return `
    <div class="row justify-content-center">
      <div class="col-lg-10">
        <form method="post" action="/test/submit" class="card">
          <div class="card-body">
            <h5 class="card-title">${mode === 'review' ? 'Review Session' : 'Practice Test'}</h5>
            <p class="card-text">Select the best answer(s) for each question. Questions may have multiple correct answers.</p>
            <div class="accordion" id="testAccordion">
              ${accordionItems}
            </div>
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

    const { bank, questions, domains, questionCount } = loadQuestionContext();
    const wrongAnswers = loadWrongAnswers();

    if (pathname === '/questions' && req.method === 'GET') {
      const perPage = 10;
      const domainFilter = (requestUrl.searchParams.get('domain') || '').trim();
      const searchFilter = (requestUrl.searchParams.get('q') || '').trim();
      const filtered = filterQuestionsByParams(questions, domainFilter, searchFilter);
      const totalQuestions = filtered.length;
      const totalPages = Math.max(1, Math.ceil(Math.max(totalQuestions, 1) / perPage));
      const requestedPage = Number.parseInt(requestUrl.searchParams.get('page') || '1', 10);
      const page = Number.isFinite(requestedPage) && requestedPage >= 1 ? Math.min(requestedPage, totalPages) : 1;
      const startIndex = (page - 1) * perPage;
      const pageItems = filtered.slice(startIndex, startIndex + perPage);
      const body = renderQuestionList({
        questions: pageItems,
        page,
        totalPages,
        perPage,
        totalQuestions,
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
        let selectedQuestions = [];
        if (selectionScope === 'all' && selectAllPages) {
          selectedQuestions = filterQuestionsByParams(questions, domainFilter, searchFilter);
          if (!selectedQuestions.length) {
            addFlash(session, 'warning', 'No questions match the current filters to export.');
            redirect(res, redirectUrl);
            return;
          }
        } else {
          if (!selectedIds.length) {
            addFlash(session, 'warning', 'Select at least one question to export or choose “Export all”.');
            redirect(res, redirectUrl);
            return;
          }
          const idSet = new Set(selectedIds);
          selectedQuestions = questions.filter((question) => idSet.has(question.id));
          if (!selectedQuestions.length) {
            addFlash(session, 'warning', 'No matching questions were found for the selected items.');
            redirect(res, redirectUrl);
            return;
          }
        }
        exportIds = selectedQuestions.map((question) => question.id);
      }
      const exportPayload = buildExportPayload(bank, exportIds);
      const payload = JSON.stringify(exportPayload, null, 2);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="questions_export.json"');
      res.end(payload);
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
      const body = renderQuestionForm({ question, errors: [] });
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
      const domain = (formData.get('domain') || '').trim() || 'General';
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
      if (errors.length) {
        const draft = {
          ...questions[index],
          question: questionText,
          domain,
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
        const body = renderQuestionForm({ question: draft, errors });
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
        const filtered = filterQuestionsByParams(questions, domainFilter, searchFilter);
        if (!filtered.length) {
          addFlash(session, 'warning', 'No questions match the current filters to delete.');
          redirect(res, redirectUrl);
          return;
        }
        const filteredIds = new Set(filtered.map((question) => question.id));
        const removedCount = removeQuestionsById(bank, filteredIds);
        if (!removedCount) {
          addFlash(session, 'warning', 'No questions match the current filters to delete.');
          redirect(res, redirectUrl);
          return;
        }
        const remainingWrongAnswers = wrongAnswers.filter((item) => !filteredIds.has(item.question_id));
        if (remainingWrongAnswers.length !== wrongAnswers.length) {
          saveWrongAnswers(remainingWrongAnswers);
        }
        saveQuestionBank(bank);
        addFlash(
          session,
          'success',
          removedCount === 1 ? 'Deleted 1 question.' : `Deleted ${removedCount} questions.`,
        );
        redirect(res, redirectUrl);
        return;
      }
      if (!selectedIds.length) {
        addFlash(session, 'warning', 'Select at least one question to delete.');
        redirect(res, redirectUrl);
        return;
      }
      const idSet = new Set(selectedIds);
      const removedCount = removeQuestionsById(bank, idSet);
      if (removedCount === 0) {
        addFlash(session, 'warning', 'No matching questions were found for the selected items.');
        redirect(res, redirectUrl);
        return;
      }
      const remainingWrongAnswers = wrongAnswers.filter((item) => !idSet.has(item.question_id));
      if (remainingWrongAnswers.length !== wrongAnswers.length) {
        saveWrongAnswers(remainingWrongAnswers);
      }
      saveQuestionBank(bank);
      addFlash(
        session,
        'success',
        removedCount === 1 ? 'Deleted 1 question.' : `Deleted ${removedCount} questions.`,
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
      if (req.method === 'GET') {
        const body = renderImport();
        sendHtml(
          res,
          renderLayout({
            title: 'Import Questions · CISSP Test Simulator',
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
        } else {
          const formData = new URLSearchParams(bodyBuffer.toString());
          payloadText = formData.get('questions_json') || '';
          textImport = formData.get('questions_text') || '';
          batchDomain = formData.get('batch_domain') || '';
        }
        const trimmedTextImport = (textImport || '').trim();
        if (trimmedTextImport) {
          try {
            const prepared = parseStructuredTextImport(trimmedTextImport, batchDomain);
            const stats = importQuestions(prepared);
            addFlash(session, 'success', `Imported ${stats.imported} questions, updated ${stats.updated}.`);
            redirect(res, '/');
          } catch (error) {
            addFlash(session, 'danger', `Failed to import questions: ${error.message}`);
            redirect(res, '/import');
          }
          return;
        }
        const trimmedPayload = (payloadText || '').trim();
        if (!trimmedPayload) {
          addFlash(session, 'danger', 'Provide questions JSON by pasting data or uploading a file.');
          redirect(res, '/import');
          return;
        }
        try {
          const parsed = JSON.parse(trimmedPayload);
          const stats = importQuestions(parsed);
          addFlash(session, 'success', `Imported ${stats.imported} questions, updated ${stats.updated}.`);
          redirect(res, '/');
        } catch (error) {
          addFlash(session, 'danger', `Failed to import questions: ${error.message}`);
          redirect(res, '/import');
        }
        return;
      }
    }

    if (pathname === '/test/new') {
      if (req.method === 'GET') {
        const body = renderNewTest({ questionCount, domains });
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
        if (questionCount === 0) {
          addFlash(session, 'warning', 'Import questions before creating a test.');
          redirect(res, '/import');
          return;
        }
        const bodyBuffer = await collectRequestBody(req);
        const formData = new URLSearchParams(bodyBuffer.toString());
        const domain = formData.get('domain') || '';
        const filtered = questions.filter((q) => !domain || q.domain === domain);
        if (!filtered.length) {
          addFlash(session, 'warning', 'No questions available for the selected criteria.');
          redirect(res, '/test/new');
          return;
        }
        const requested = Number.parseInt(formData.get('total_questions') || '0', 10);
        const totalQuestions = Math.max(1, Math.min(Number.isFinite(requested) ? requested : filtered.length, filtered.length));
        const selected = takeRandomSample(filtered, totalQuestions).map((question) => ({
          ...question,
        }));
        session.currentTest = {
          questions: selected,
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
