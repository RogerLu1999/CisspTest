# CISSP Test Simulator

A lightweight Node.js web application for managing CISSP-style practice questions, creating randomized tests, and focusing on missed questions.

## Features

- Import questions from local JSON files and persist them to disk.
- Import long-form exam dumps where questions appear first and the answer key follows at the end.
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

Use the provided [`sample_data/sample_question_groups.json`](sample_data/sample_question_groups.json) file to populate the question bank. Copy the JSON payload into the importer form.

To import a transcript that lists all questions before their answers:

1. Paste the passage into the <strong>Import from structured text</strong> form.
2. Keep the questions in order (1, 2, 3, …) with their answer choices (A, B, C, …).
3. Add an <strong>Answers</strong> (or <strong>答案</strong>) heading near the end and list each answer starting with its number, followed by the correct option and any explanation.
4. Provide the domain that should apply to the entire batch.

The importer automatically associates the answer key entries with their matching questions, keeps shared scenarios intact, and saves the explanations alongside the questions.

## Question JSON format

The importer expects question **groups**. Each group belongs to a single domain, may include an optional shared context, and contains one or more questions. A minimal example looks like this:

```json
{
  "version": 2,
  "groups": [
    {
      "id": "example-group",
      "domain": "Security and Risk Management",
      "context": "You are advising an enterprise on how to build its governance program.",
      "questions": [
        {
          "id": "example-question-1",
          "question": "Which artifact establishes accountability for approving security exceptions?",
          "choices": [
            "Incident response plan",
            "Information security charter",
            "Data classification guideline",
            "Patch management runbook"
          ],
          "correct_answers": [1],
          "explanation": "The charter grants the security function its authority, including who signs off on exceptions."
        }
      ]
    }
  ]
}
```

- `correct_answers` is a list of **0-based** indices referencing the `choices` array. Multiple indices indicate a multi-select question.
- `context` is optional. When provided, it is shown above every question in the group.
- `explanation` stores the official rationale that appears after submitting a test or viewing the question details.
- Group and question `id` values are optional. When omitted, deterministic identifiers are generated from the content so that re-imports update the same records.

## Data storage

Imported questions are saved under `data/questions.json` as the grouped structure shown above. Any missed questions are tracked in `data/wrong_questions.json`. Both files are standard JSON and can be backed up or edited manually as needed.
