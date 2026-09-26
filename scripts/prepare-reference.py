#!/usr/bin/env python3
"""Extract article text from the supplied Word files' embedded MHT pages."""

import hashlib
import json
import sys
from email import policy
from email.parser import BytesParser
from html.parser import HTMLParser
from pathlib import Path
from zipfile import ZipFile


class ArticleText(HTMLParser):
    BREAKS = {
        "br", "p", "div", "section", "article", "h1", "h2", "h3", "h4",
        "h5", "h6", "li", "ul", "ol", "tr", "table", "blockquote",
    }

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.hidden = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style"}:
            self.hidden += 1
        elif tag in self.BREAKS:
            self.parts.append("\n")
        elif tag in {"td", "th"}:
            self.parts.append("\t")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style"}:
            self.hidden = max(0, self.hidden - 1)
        elif tag in self.BREAKS or tag in {"td", "th"}:
            self.parts.append("\n" if tag in self.BREAKS else "\t")

    def handle_data(self, data: str) -> None:
        if not self.hidden:
            self.parts.append(data)

    def text(self) -> str:
        lines = [" ".join(line.split()) for line in "".join(self.parts).splitlines()]
        return "\n".join(line for line in lines if line)


def extract(path: Path) -> tuple[str, int]:
    with ZipFile(path) as document:
        mht = document.read("word/afchunk.mht")
    message = BytesParser(policy=policy.default).parsebytes(mht)
    parts = [part for part in message.walk() if not part.is_multipart()]
    html = next(part.get_content() for part in parts if part.get_content_type() == "text/html")
    parser = ArticleText()
    parser.feed(html)
    image_count = sum(part.get_content_maintype() == "image" for part in parts)
    return parser.text(), image_count


def main() -> None:
    if len(sys.argv) < 4:
        raise SystemExit("Usage: prepare-reference.py FOLDER... OUTPUT.jsonl")
    roots = [Path(value) for value in sys.argv[1:-1]]
    destination = Path(sys.argv[-1])
    if destination.suffix != ".jsonl":
        raise SystemExit("The output must be JSONL")

    articles: dict[str, dict] = {}
    files = sorted(path for root in roots for path in root.rglob("*.docx"))
    for path in files:
        text, images = extract(path)
        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
        if digest not in articles:
            articles[digest] = {
                "article_id": digest,
                "title": path.stem,
                "text": text,
                "image_count": images,
                "source_files": [],
            }
        articles[digest]["source_files"].append(str(path))

    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("w", encoding="utf-8") as output:
        for article in articles.values():
            output.write(json.dumps(article, ensure_ascii=True) + "\n")
    empty = sum(not article["text"] for article in articles.values())
    images = sum(article["image_count"] for article in articles.values())
    print(
        f"Read {len(files)} Word files; {len(articles)} unique text articles; "
        f"{empty} empty; {images} embedded images"
    )


if __name__ == "__main__":
    main()
