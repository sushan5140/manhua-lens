"""Refresh the notebook's embedded public helpers after editing their source."""
import ast
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
PUBLIC_FILES = ["voice_assets.py", "engine.py", "korean_frontend.py", "setup_runtime.py", "prepare_voice.py",
                "reference_selection.py", "requirements.txt", "requirements-models.txt", "requirements-extraction.txt"]


def main():
    path = HERE / "kaggle_prepare.ipynb"
    notebook = json.loads(path.read_text(encoding="utf-8"))
    sources = {name: (HERE / name).read_text(encoding="utf-8-sig") for name in PUBLIC_FILES}
    found = False
    for cell in notebook["cells"]:
        if cell["cell_type"] != "code":
            continue
        # Never carry private execution results into a source notebook.
        cell["outputs"] = []
        cell["execution_count"] = None
        lines = "".join(cell["source"]).splitlines(keepends=True)
        for node in ast.parse("".join(lines)).body:
            if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "PUBLIC_SOURCES" for t in node.targets):
                lines[node.lineno - 1:node.end_lineno] = ["PUBLIC_SOURCES = " + repr(sources) + "\n"]
                cell["source"] = lines
                found = True
                break
    if not found:
        raise ValueError("Notebook PUBLIC_SOURCES assignment not found")
    path.write_text(json.dumps(notebook, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
