# CISSP Test Simulator

A lightweight Node.js web application for managing CISSP-style practice questions, creating randomized tests, and focusing on missed questions.

## Features

- Import questions from local JSON files and persist them to disk.
- Build randomized practice tests with optional domain filters.
- Take tests in the browser, receive instant scoring, and view detailed explanations.
- Track questions answered incorrectly and automatically create review sessions from them.

## Getting started

1. **Install dependencies**

   The application has no external runtime dependencies. If you would like to keep a local `node_modules` directory for future extensions you can run `npm install`, but it is not required to run the server.

2. **Run the development server**

   ```bash
   node server.js
   ```

   The application will be available at <http://127.0.0.1:8000/> when running locally.
   It binds to all interfaces by default, so hosted environments can reach it via their forwarded URLs without further changes.

3. **Import sample questions (optional)**

Use the provided [`sample_data/sample_questions.json`](sample_data/sample_questions.json) file to populate the question bank. Copy the JSON payload into the importer form.

## Question JSON format

Each question entry should resemble the following structure:

```json
{
  "question": "Which security control is considered preventative?",
  "choices": ["Security camera", "Security guard", "Encryption", "Audit log"],
  "answer": "C",
  "domain": "Security and Risk Management",
  "comment": "Encryption prevents unauthorized disclosure."
}
```

- `answer` may be a letter (A, B, C, ...), the exact choice text, the index of the correct option (0-based), or an array of any of these values for multi-answer questions.
- If an `id` is omitted, one will be generated deterministically from the prompt so that re-imports update the original record.

## Data storage

Imported questions are saved under `data/questions.json`. Any missed questions are tracked in `data/wrong_questions.json`. Both files are standard JSON and can be backed up or edited manually as needed.
