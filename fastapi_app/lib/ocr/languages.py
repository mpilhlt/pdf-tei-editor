"""
Normalized language codes for OCR engines.

The normalized form is the BCP 47 tag that is also used for `xml:lang` in the
teiHeader (see `normalize_language_code()` in tei_utils): the ISO 639-1 code
where one exists (`de`, `en`), the ISO 639-3 code otherwise (`grc`, `ceb`),
optionally followed by a script subtag (`zh-Hans`, `de-Latf`, `sr-Latn`).

OCR engines map their own codes (Tesseract uses ISO 639-2/T codes such as
`deu`) to and from this form with the helpers in this module.
"""

from typing import Optional

from fastapi_app.lib.utils.tei_utils import normalize_language_code

ISO639_1_TO_3: dict[str, str] = {
    "aa": "aar", "ab": "abk", "af": "afr", "ak": "aka", "am": "amh", "an": "arg", "ar": "ara",
    "as": "asm", "av": "ava", "ay": "aym", "az": "aze", "ba": "bak", "be": "bel", "bg": "bul",
    "bi": "bis", "bm": "bam", "bn": "ben", "bo": "bod", "br": "bre", "bs": "bos", "ca": "cat",
    "ce": "che", "ch": "cha", "co": "cos", "cr": "cre", "cs": "ces", "cu": "chu", "cv": "chv",
    "cy": "cym", "da": "dan", "de": "deu", "dv": "div", "dz": "dzo", "ee": "ewe", "el": "ell",
    "en": "eng", "eo": "epo", "es": "spa", "et": "est", "eu": "eus", "fa": "fas", "ff": "ful",
    "fi": "fin", "fj": "fij", "fo": "fao", "fr": "fra", "fy": "fry", "ga": "gle", "gd": "gla",
    "gl": "glg", "gn": "grn", "gu": "guj", "gv": "glv", "ha": "hau", "he": "heb", "hi": "hin",
    "ho": "hmo", "hr": "hrv", "ht": "hat", "hu": "hun", "hy": "hye", "hz": "her", "ia": "ina",
    "id": "ind", "ie": "ile", "ig": "ibo", "ii": "iii", "ik": "ipk", "io": "ido", "is": "isl",
    "it": "ita", "iu": "iku", "ja": "jpn", "jv": "jav", "ka": "kat", "kg": "kon", "ki": "kik",
    "kj": "kua", "kk": "kaz", "kl": "kal", "km": "khm", "kn": "kan", "ko": "kor", "kr": "kau",
    "ks": "kas", "ku": "kur", "kv": "kom", "kw": "cor", "ky": "kir", "la": "lat", "lb": "ltz",
    "lg": "lug", "li": "lim", "ln": "lin", "lo": "lao", "lt": "lit", "lu": "lub", "lv": "lav",
    "mg": "mlg", "mh": "mah", "mi": "mri", "mk": "mkd", "ml": "mal", "mn": "mon", "mr": "mar",
    "ms": "msa", "mt": "mlt", "my": "mya", "na": "nau", "nb": "nob", "nd": "nde", "ne": "nep",
    "ng": "ndo", "nl": "nld", "nn": "nno", "no": "nor", "nr": "nbl", "nv": "nav", "ny": "nya",
    "oc": "oci", "oj": "oji", "om": "orm", "or": "ori", "os": "oss", "pa": "pan", "pi": "pli",
    "pl": "pol", "ps": "pus", "pt": "por", "qu": "que", "rm": "roh", "rn": "run", "ro": "ron",
    "ru": "rus", "rw": "kin", "sa": "san", "sc": "srd", "sd": "snd", "se": "sme", "sg": "sag",
    "si": "sin", "sk": "slk", "sl": "slv", "sm": "smo", "sn": "sna", "so": "som", "sq": "sqi",
    "sr": "srp", "ss": "ssw", "st": "sot", "su": "sun", "sv": "swe", "sw": "swa", "ta": "tam",
    "te": "tel", "tg": "tgk", "th": "tha", "ti": "tir", "tk": "tuk", "tl": "tgl", "tn": "tsn",
    "to": "ton", "tr": "tur", "ts": "tso", "tt": "tat", "tw": "twi", "ty": "tah", "ug": "uig",
    "uk": "ukr", "ur": "urd", "uz": "uzb", "ve": "ven", "vi": "vie", "vo": "vol", "wa": "wln",
    "wo": "wol", "xh": "xho", "yi": "yid", "yo": "yor", "za": "zha", "zh": "zho", "zu": "zul",
}
"""ISO 639-1 codes mapped to their ISO 639-2/T (= ISO 639-3) equivalents."""

ISO639_3_TO_1: dict[str, str] = {v: k for k, v in ISO639_1_TO_3.items()}
"""ISO 639-2/T codes mapped to their ISO 639-1 equivalents."""

ISO639_2B_TO_T: dict[str, str] = {
    "alb": "sqi", "arm": "hye", "baq": "eus", "bur": "mya", "chi": "zho", "cze": "ces",
    "dut": "nld", "fre": "fra", "geo": "kat", "ger": "deu", "gre": "ell", "ice": "isl",
    "mac": "mkd", "mao": "mri", "may": "msa", "per": "fas", "rum": "ron", "slo": "slk",
    "tib": "bod", "wel": "cym",
}
"""ISO 639-2/B (bibliographic) codes mapped to their ISO 639-2/T (terminology) equivalents."""


def normalize_ocr_language(value: Optional[str]) -> Optional[str]:
    """
    Normalize a language code to the form used in the teiHeader.

    Accepts ISO 639-1, ISO 639-2/B, ISO 639-2/T and ISO 639-3 codes with optional
    subtags, and returns the shortest equivalent BCP 47 tag. Script subtags are
    title-cased, region subtags upper-cased.

    Args:
        value: Language code such as "de", "deu", "ger" or "zh-hans"

    Returns:
        The normalized tag (e.g. "de", "zh-Hans"), or None if the value is not a language code
    """
    tag = normalize_language_code(value)
    if tag is None:
        return None
    primary, *rest = tag.split("-")
    primary = ISO639_2B_TO_T.get(primary, primary)
    primary = ISO639_3_TO_1.get(primary, primary)
    subtags = []
    for subtag in rest:
        if len(subtag) == 4 and subtag.isalpha():
            subtags.append(subtag.title())
        elif len(subtag) == 2 and subtag.isalpha():
            subtags.append(subtag.upper())
        else:
            subtags.append(subtag)
    return "-".join([primary, *subtags])


def to_iso639_3(value: Optional[str]) -> Optional[str]:
    """
    Return the three-letter ISO 639-2/T code for the primary subtag of a language code.

    Args:
        value: Language code such as "de" or "de-Latf"

    Returns:
        The three-letter code (e.g. "deu"), or None if the value is not a language code
    """
    tag = normalize_ocr_language(value)
    if tag is None:
        return None
    primary = tag.split("-")[0]
    return ISO639_1_TO_3.get(primary, primary if len(primary) == 3 else None)
