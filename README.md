# CISSP Test Simulator

A lightweight Flask web application for managing CISSP-style practice questions, creating randomized tests, and focusing on missed questions.

## Features

- Import questions from local JSON files and persist them to disk.
- Build randomized practice tests with optional domain filters.
- Take tests in the browser, receive instant scoring, and view detailed explanations.
- Track questions answered incorrectly and automatically create review sessions from them.

## Getting started

1. **Install dependencies**

   ```bash
   pip install -r requirements.txt
   ```

2. **Run the development server**

   ```bash
   flask --app app run --debug
   ```

   The application will be available at <http://127.0.0.1:5000/>.

3. **Import sample questions (optional)**

   Use the provided [`sample_data/sample_questions.json`](sample_data/sample_questions.json) file to populate the question bank.

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
