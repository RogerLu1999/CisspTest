const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const crypto = require('crypto');

const BASE_DIR = __dirname;
const DATA_DIR = path.join(BASE_DIR, 'data');
const QUESTIONS_FILE = path.join(DATA_DIR, 'questions.json');
const WRONG_FILE = path.join(DATA_DIR, 'wrong_questions.json');
const HOST = '0.0.0.0';
const PORT = process.env.PORT ? Number(process.env.PORT) : 5000;

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

function importQuestions(rawData) {
  const existing = new Map();
  for (const question of readJson(QUESTIONS_FILE)) {
    if (question && question.id) {
      existing.set(question.id, question);
    }
  }
  let imported = 0;
  let updated = 0;
  let items = [];
  if (Array.isArray(rawData)) {
    items = rawData;
  } else if (rawData && typeof rawData === 'object') {
    if (Array.isArray(rawData.questions)) {
      items = rawData.questions;
    } else if (Array.isArray(rawData.data)) {
      items = rawData.data;
    } else if (rawData.questions && typeof rawData.questions === 'object') {
      items = Object.values(rawData.questions);
    }
  }
  if (!Array.isArray(items)) {
    throw new Error('Unsupported format. Expected a list of questions.');
  }
  for (const rawQuestion of items) {
    try {
      const question = normalizeQuestion(rawQuestion);
      if (existing.has(question.id)) {
        existing.set(question.id, question);
        updated += 1;
      } else {
        existing.set(question.id, question);
        imported += 1;
      }
    } catch (error) {
      continue;
    }
  }
  writeJson(QUESTIONS_FILE, Array.from(existing.values()));
  return { imported, updated };
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
    <div class="row justify-content-center">
      <div class="col-lg-6">
        <div class="card">
          <div class="card-body">
            <h5 class="card-title">Import questions</h5>
            <p class="card-text">Paste a JSON array (or an object with a <code>questions</code> list) containing your CISSP-style questions. Each entry should include the prompt, choices, and the correct answer(s).</p>
            <form method="post">
              <div class="mb-3">
                <label for="questions_json" class="form-label">Questions JSON</label>
                <textarea class="form-control" id="questions_json" name="questions_json" rows="10" required></textarea>
                <div class="form-text">The importer accepts the same format as <code>sample_data/sample_questions.json</code>.</div>
              </div>
              <button type="submit" class="btn btn-primary">Import Questions</button>
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
            ${question.comment ? `<p><strong>Comment:</strong> ${escapeHtml(question.comment)}</p>` : ''}\
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
        sendHtml(res, renderLayout({
          title: 'Not found',
          questionCount: readJson(QUESTIONS_FILE).length,
          wrongCount: loadWrongAnswers().length,
          domains: [],
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

    const questions = readJson(QUESTIONS_FILE);
    const wrongAnswers = loadWrongAnswers();
    const domains = Array.from(new Set(questions.map((q) => q.domain || 'General'))).sort();

    if (req.method === 'GET' && pathname === '/') {
      const wrongDetails = wrongAnswers.map((item) => ({
        ...item,
        question: questions.find((q) => q.id === item.question_id) || null,
      }));
      const body = renderIndex({
        questionCount: questions.length,
        wrongCount: wrongAnswers.length,
        domains,
        wrongDetails,
      });
      sendHtml(
        res,
        renderLayout({
          title: 'Dashboard · CISSP Test Simulator',
          questionCount: questions.length,
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
            questionCount: questions.length,
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
        const formData = new URLSearchParams(bodyBuffer.toString());
        const payloadText = formData.get('questions_json');
        if (!payloadText) {
          addFlash(session, 'danger', 'Please paste a JSON payload.');
          redirect(res, '/import');
          return;
        }
        try {
          const parsed = JSON.parse(payloadText);
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
        const body = renderNewTest({ questionCount: questions.length, domains });
        sendHtml(
          res,
          renderLayout({
            title: 'New Test · CISSP Test Simulator',
            questionCount: questions.length,
            wrongCount: wrongAnswers.length,
            domains,
            flashMessages,
            body,
          }),
        );
        return;
      }
      if (req.method === 'POST') {
        if (questions.length === 0) {
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
            questionCount: questions.length,
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
          questionCount: questions.length,
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
            questionCount: questions.length,
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
        questionCount: questions.length,
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
