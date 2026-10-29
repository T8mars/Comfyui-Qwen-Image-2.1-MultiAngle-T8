"""Build-time only: pip install pypinyin==0.55.0; pass a pinned pose-zh.json."""
import argparse
import json
from pathlib import Path
import re

from pypinyin import lazy_pinyin, Style, load_phrases_dict


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    # Action-language readings: 托腮/侧卧/朝天/抚发 must not use the noun readings.
    load_phrases_dict({"朝天": [["cháo"], ["tiān"]], "抚发": [["fǔ"], ["fà"]],
                       "撩发": [["liāo"], ["fà"]], "交叠": [["jiāo"], ["dié"]]})
    rows = json.loads(args.source.read_text("utf-8-sig"))
    result = {}
    for row in rows:
        title = row["姿势名称"]
        keys = [title, *re.split(r"[・·（）()＋+]", title)]
        terms = set()
        for key in keys:
            for style in (Style.NORMAL, Style.FIRST_LETTER):
                term = "".join(lazy_pinyin(key, style=style)).lower()
                term = re.sub(r"[^a-z0-9]", "", term)
                if len(term) >= 2:
                    terms.add(term)
        result[row["id"].rsplit("_", 1)[0]] = sorted(terms)
    args.output.write_text("// Generated from anhao/ai-pose-gallery-zh @ 072a369; tools/build_gallery_pinyin.py (pypinyin 0.55.0).\n"
                           + "// Title spellings only; no runtime model, package or network request.\n"
                           + "export const GALLERY_PINYIN = " + json.dumps(result, ensure_ascii=False, indent=2) + ";\n", "utf-8")


if __name__ == "__main__":
    main()
