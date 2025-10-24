import json
import os
import uuid
import random
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List

from flask import (
    Flask,
    flash,
    redirect,
    render_template,
    request,
    session,
    url_for,
)

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
QUESTIONS_FILE = DATA_DIR / "questions.json"
WRONG_FILE = DATA_DIR / "wrong_questions.json"


def load_json(path: Path) -> List[Dict[str, Any]]:
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8") as f:
        try:
            return json.load(f)
        except json.JSONDecodeError:
            return []


def save_json(path: Path, data: List[Dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def normalize_correct_answers(raw_answers: Any, choices: List[str]) -> List[int]:
    if raw_answers is None:
        return []
    if isinstance(raw_answers, (str, int)):
        raw_answers = [raw_answers]
    normalized: List[int] = []
    lower_choices = [choice.lower() for choice in choices]
    for answer in raw_answers:
        if isinstance(answer, int):
            if 0 <= answer < len(choices):
                normalized.append(answer)
        elif isinstance(answer, str):
            stripped = answer.strip()
            # Match by letter (A, B, C, D) if provided
            if len(stripped) == 1 and stripped.upper() in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
                idx = ord(stripped.upper()) - ord("A")
                if 0 <= idx < len(choices):
                    normalized.append(idx)
                    continue
            # Match by exact option text
            lowered = stripped.lower()
            try:
                idx = lower_choices.index(lowered)
                normalized.append(idx)
            except ValueError:
                continue
    return sorted(set(normalized))


def normalize_question(raw_question: Dict[str, Any]) -> Dict[str, Any]:
    question_text = (
        raw_question.get("question")
        or raw_question.get("text")
        or raw_question.get("prompt")
    )
    if not question_text:
        raise ValueError("Question text is required")

    raw_choices = raw_question.get("choices") or raw_question.get("options")
    if isinstance(raw_choices, dict):
        # Sort by key to keep deterministic order if provided as dict
        raw_choices = [raw_choices[key] for key in sorted(raw_choices.keys())]
    if not isinstance(raw_choices, list) or len(raw_choices) < 2:
        raise ValueError("Choices must be a list with at least two options")
    choices = [str(choice) for choice in raw_choices]

    raw_correct = (
        raw_question.get("correct_answers")
        or raw_question.get("correct_answer")
        or raw_question.get("answer")
        or raw_question.get("answers")
    )
    correct_answers = normalize_correct_answers(raw_correct, choices)

    if not correct_answers:
        raise ValueError("At least one correct answer is required")

    domain_value = raw_question.get("domain", "General")
    domain = str(domain_value).strip() if domain_value is not None else "General"
    if not domain:
        domain = "General"
    comment_value = raw_question.get("comment") or raw_question.get("explanation") or ""
    comment = str(comment_value).strip() if comment_value is not None else ""

    question_id = raw_question.get("id") or raw_question.get("uuid")
    if not question_id:
        namespace = uuid.uuid5(uuid.NAMESPACE_DNS, question_text)
        question_id = str(uuid.uuid5(namespace, "cissp-question"))

    return {
        "id": str(question_id),
        "question": question_text.strip(),
        "choices": choices,
        "correct_answers": correct_answers,
        "domain": domain,
        "comment": comment,
    }


def import_questions(raw_data: Any) -> Dict[str, int]:
    existing_questions = {q["id"]: q for q in load_json(QUESTIONS_FILE)}
    imported = 0
    updated = 0
    items: List[Dict[str, Any]]
    if isinstance(raw_data, dict):
        items = raw_data.get("questions") or raw_data.get("data") or []
        if isinstance(items, dict):
            items = list(items.values())
    else:
        items = raw_data
    if not isinstance(items, list):
        raise ValueError("Unsupported format. Expected a list of questions.")

    for raw_question in items:
        try:
            question = normalize_question(raw_question)
        except ValueError:
            continue
        if question["id"] in existing_questions:
            existing_questions[question["id"]] = question
            updated += 1
        else:
            existing_questions[question["id"]] = question
            imported += 1

    save_json(QUESTIONS_FILE, list(existing_questions.values()))
    return {"imported": imported, "updated": updated}


def load_wrong_answers() -> List[Dict[str, Any]]:
    return load_json(WRONG_FILE)


def save_wrong_answers(data: List[Dict[str, Any]]) -> None:
    save_json(WRONG_FILE, data)


def update_wrong_answers(question_id: str, selected_indices: List[int], is_correct: bool) -> None:
    wrong_answers = load_wrong_answers()
    wrong_lookup = {item["question_id"]: item for item in wrong_answers}
    if is_correct:
        if question_id in wrong_lookup:
            wrong_answers = [item for item in wrong_answers if item["question_id"] != question_id]
            save_wrong_answers(wrong_answers)
        return

    if question_id in wrong_lookup:
        wrong_lookup[question_id]["wrong_count"] += 1
        wrong_lookup[question_id]["last_attempt"] = datetime.utcnow().isoformat()
        wrong_lookup[question_id]["last_answer"] = selected_indices
    else:
        wrong_lookup[question_id] = {
            "question_id": question_id,
            "wrong_count": 1,
            "last_attempt": datetime.utcnow().isoformat(),
            "last_answer": selected_indices,
        }
    save_wrong_answers(list(wrong_lookup.values()))


def create_app() -> Flask:
    app = Flask(__name__)
    secret_key = os.environ.get("FLASK_SECRET_KEY") or os.environ.get("SECRET_KEY")
    if not secret_key:
        secret_key = os.urandom(24)
    app.config["SECRET_KEY"] = secret_key

    @app.context_processor
    def inject_counts() -> Dict[str, Any]:
        questions = load_json(QUESTIONS_FILE)
        wrong = load_wrong_answers()
        domains = sorted({q.get("domain", "General") for q in questions})
        return {
            "question_count": len(questions),
            "wrong_count": len(wrong),
            "domains": domains,
        }

    @app.route("/")
    def index():
        recent_wrong = load_wrong_answers()
        questions = load_json(QUESTIONS_FILE)
        return render_template(
            "index.html",
            questions=questions,
            wrong_answers=recent_wrong,
        )

    @app.route("/import", methods=["GET", "POST"])
    def import_view():
        if request.method == "POST":
            uploaded_file = request.files.get("questions_file")
            if not uploaded_file or uploaded_file.filename == "":
                flash("Please choose a JSON file to upload.", "danger")
                return redirect(request.url)
            try:
                payload = json.load(uploaded_file)
                stats = import_questions(payload)
                flash(
                    f"Imported {stats['imported']} questions, updated {stats['updated']}.",
                    "success",
                )
                return redirect(url_for("index"))
            except (json.JSONDecodeError, ValueError) as exc:
                flash(f"Failed to import questions: {exc}", "danger")
                return redirect(request.url)
        return render_template("import.html")

    @app.route("/test/new", methods=["GET", "POST"])
    def new_test():
        questions = load_json(QUESTIONS_FILE)
        if not questions:
            flash("Import questions before creating a test.", "warning")
            return redirect(url_for("import_view"))

        if request.method == "POST":
            try:
                total_questions = int(request.form.get("total_questions", 0))
            except ValueError:
                total_questions = 0
            selected_domain = request.form.get("domain")
            filtered = [q for q in questions if not selected_domain or q["domain"] == selected_domain]
            if not filtered:
                flash("No questions available for the selected criteria.", "warning")
                return redirect(request.url)
            total_questions = max(1, min(total_questions or len(filtered), len(filtered)))
            selected_questions = random.sample(filtered, total_questions)
            session["current_test"] = {
                "questions": selected_questions,
                "timestamp": datetime.utcnow().isoformat(),
                "mode": "standard",
            }
            return redirect(url_for("take_test"))

        return render_template("new_test.html")

    @app.route("/test")
    def take_test():
        test = session.get("current_test")
        if not test:
            flash("Start a test to access this page.", "info")
            return redirect(url_for("new_test"))
        return render_template("test.html", questions=test["questions"], mode=test.get("mode", "standard"))

    @app.route("/test/submit", methods=["POST"])
    def submit_test():
        test = session.get("current_test")
        if not test:
            flash("No active test found.", "warning")
            return redirect(url_for("new_test"))

        questions = test["questions"]
        results = []
        correct_count = 0
        for question in questions:
            form_key = f"q_{question['id']}"
            selected_indices = request.form.getlist(form_key)
            selected = sorted({int(choice) for choice in selected_indices}) if selected_indices else []
            correct_answers = sorted(question["correct_answers"])
            is_correct = selected == correct_answers
            if is_correct:
                correct_count += 1
            update_wrong_answers(question["id"], selected, is_correct)
            results.append(
                {
                    "question": question,
                    "selected": selected,
                    "is_correct": is_correct,
                    "correct_answers": correct_answers,
                }
            )

        total_questions = len(questions)
        score = round((correct_count / total_questions) * 100, 2) if total_questions else 0
        session["last_results"] = {
            "results": results,
            "score": score,
            "correct_count": correct_count,
            "total_questions": total_questions,
            "mode": test.get("mode", "standard"),
        }
        session.pop("current_test", None)
        return redirect(url_for("show_results"))

    @app.route("/results")
    def show_results():
        results = session.get("last_results")
        if not results:
            flash("No results to display.", "info")
            return redirect(url_for("index"))
        return render_template("results.html", **results)

    @app.route("/review", methods=["GET", "POST"])
    def review():
        questions = load_json(QUESTIONS_FILE)
        wrong_answers = load_wrong_answers()
        wrong_lookup = {item["question_id"]: item for item in wrong_answers}
        review_questions = [q for q in questions if q["id"] in wrong_lookup]

        if request.method == "POST":
            if not review_questions:
                flash("There are no questions to review right now.", "info")
                return redirect(request.url)
            try:
                total_questions = int(request.form.get("total_questions", 0))
            except ValueError:
                total_questions = 0
            total_questions = max(1, min(total_questions or len(review_questions), len(review_questions)))
            selected_questions = random.sample(review_questions, total_questions)
            session["current_test"] = {
                "questions": selected_questions,
                "timestamp": datetime.utcnow().isoformat(),
                "mode": "review",
            }
            return redirect(url_for("take_test"))

        return render_template(
            "review.html",
            review_questions=review_questions,
            wrong_lookup=wrong_lookup,
        )

    return app


app = create_app()


if __name__ == "__main__":
    app.run(debug=True)
