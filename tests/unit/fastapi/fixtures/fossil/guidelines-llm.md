# Annotation rules (compact, for LLMs)

<!--
Machine-oriented digest of docs/guidelines.md, sent to LLMs (e.g. the
PDF-TEI-Editor's LLM Reviewer) instead of the full guide to save tokens.
Not for human annotators: read docs/guidelines.md.

Each "##" section below condenses the section of docs/guidelines.md with
the same heading; the headings must stay identical so that their anchors
match. Every change to one file must be mirrored in the other. The "sync"
comment under each heading holds the hashes of both sections as of the last
sync: after mirroring a change, run
`python scripts/check-llm-digest.py --update`. Without --update, the script
fails while a section changed on only one side.
-->

## Data correction

<!-- sync: guide=cd65dcfa74923f8c1cee5ea25ed73fa50150733abcf72f15f429546b999ba272 llm=a95d2e6498bca8f9f34ad56555edd773e9bf35f7176086de35a3f77cb1b847fe -->

- Never change the text: no corrections of OCR errors, typos, noise or odd characters. Only add, remove or move tags.
- `<lb/>` is part of the text stream: never move or remove it.
- Line breaks and indentation may be changed outside the main tags. A line break equals a space: it may be added or removed as long as the spacing is kept.
- No non-whitespace character outside the direct children of `<text>`.

## Document segmentation model

<!-- sync: guide=f5e7b214a9263c527a3421394fb4932c226fbfeec7e625dbc50b0e48749ee603 llm=4996464061fccb0081fe419730cd00ef596af9007eab26c363fcc92011f47d5d -->

Direct children of `<text>`, in document order, each repeated as often as needed:

| Element | Content |
| --- | --- |
| `<titlePage>` | publisher's cover page (usually the whole first page), optional |
| `<div type="toc">` | table of contents |
| `<front>` | bibliographic header: title, authors, affiliations, abstract, keywords, journal, first-page number footer, received/revised/accepted dates; also copyright/licence, correspondence, addresses, submission info wherever they occur; author contributions, competing interests, funding, availability statements when inside the header; footnotes referenced from the header (e.g. `*` affiliation/acknowledgement notes) |
| `<note place="headnote">` | running page header (journal, author, title on later pages); on page 1 this goes into `<front>` |
| `<body>` | article text incl. headings, figures, tables and their captions |
| `<listBibl>` | footnotes or endnotes that contain at least one reference, incl. mixed comment + reference |
| `<note place="footnote">` | footnotes without any reference, page footers, repeated footer text; margin notes about the body |
| `<page>` | page number, outside any `<note>` |
| `<div type="acknowledgement">`, `"availability"`, `"funding"`, `"conflict"`, `"contribution"` | these statements as annexes after the body (not in the header) |
| `<div type="annex">` | any other annex or supplementary text/figure/table after the body; one `<div>` per annex section |

- Footnotes referenced from the body stay out of `<front>`, even on page 1.
- Figures/tables belong to `<body>`, or to the `<div type="annex">`/`<front>` they appear in.
- Text of a preceding article at the top of the first page: no element; remove any `<front>`/`<body>` around it.
- Hidden (invisible) text picked up from the PDF: no element.
- Do not move headnotes, footnotes, `<page>` or stray header numbering to where they "should" be; annotate them where they are.
- No `<title>`/`<author>` at this level.

## Reference segmentation model

<!-- sync: guide=e91202229fbc749bba7ca3c8b408f4fa6afe9b3928a298a1a6af3b24d82d2752 llm=1c151b573714185e1ef6283d8bec01cb779331a34426f0f5caaba320353e0f76 -->

Splits the content of `<listBibl>` into:

- `<label>`: the footnote or reference number.
- `<bibl>`: one per reference, including the commentary and signal words ("See also", "Vgl. z.B.", "Anderer Meinung:") that semantically belong to it, whether before or after it.
- `<bibl type="footnote">`: a comment or note that contains no reference.

Rules:

- One `<bibl>` per cited work, whether references are separated by semicolons or sentences.
- A comment introducing several references goes only into the first (closest) `<bibl>`.
- `id.`, `op. cit.`, `a.a.O.`, `ders.`, *supra*, *infra*, "N. 22" stay plain text inside their `<bibl>` here.

```xml
<bibl><label>2</label> Dazu etwa: Hofmann, ZGE 2016, 482, 498; </bibl>
<bibl>Becker, ZGE 2016, 239, 273; </bibl>
<bibl>Raue, ZGE 2014,<lb/> 387, 389.<lb/> </bibl>
```

```xml
<bibl><label>6</label> See, ex multis: African Commission on Human and Peoples Rights, decision of 27 October 2001, Social<lb/> and Economic Rights Action Center (SERAC) and Center for Economic and Social Rights (CESR) v.<lb/> Nigeria; </bibl>
<bibl>Inter-American Court of Human Rights, judgment of 27 June 2012, Case of the Kichwa Indigenous<lb/> People of Sarayaku v. Ecuador.<lb/> </bibl>
```

## Citation model

<!-- sync: guide=8fb50aec91ca03f283760d8dd981b6eb9320c33f0f1163f5b8bb0a751bca4cab llm=9ddd75e0b3e0b61bd6231399b9810141f68d3c137f9b39d684c96aa4cc18ec1d -->

Labels the inside of each `<bibl>`. All elements except `<label>` and `<lb/>` may occur any number of times, in any order. Punctuation, "in:", brackets, "p."/"pp."/"S." and the like stay outside tags unless stated otherwise.

### Elements

| Element | Use |
| --- | --- |
| `<author>`, `<editor>` | one element per person or organization, even in a comma/"and"/"&" run; optional inner `<persName>`/`<forename>`/`<surname>` |
| `<title level="a">` | article, chapter, post or page, commentary entry, case name |
| `<title level="j">` | journal (incl. law review abbreviation with volume, e.g. `97 Yale L.J.`) or blog |
| `<title level="m">` | book, proceedings, thesis, whole website, commentary, statute |
| `<title level="s">`, `<title level="u">` | series, unpublished work |
| `<date type="publication">` | publication date (default type) |
| `<biblScope unit="...">` | the cited work's own extent; `@unit` is one of `page` (the article's full page range), `volume`, `issue` |
| `<citedRange unit="...">` | a pinpoint into the work (see below), sibling of `<biblScope>`, never nested in it |
| `<publisher>`, `<pubPlace>` | publisher (also corporate web publisher), place |
| `<edition n="2">` | edition statement |
| `<idno type="...">` | identifier; `@type` is one of `DOI`, `ISSN`, `arXiv`, `report` (report number), `docket`, `ECLI`, `CELEX`, `actNumber` (official number of a legislative act, "2019/790") |
| `<ptr type="web" target="URL">` | URL as text, without "URL:" and trailing period |
| `<note type="report">` | other note, e.g. "Ph.D. thesis", "Technical Report" |
| `<orgName type="...">` | institution that is not the issuing authority, e.g. a thesis's university; `@type` is one of `institution`, `collaboration`, `department`, `laboratory` |
| `<authority type="...">` | court (`type="court"`), legislature (`type="legislature"`) or other issuing body of the cited work; never `<author>` or bare `<orgName>` for it; may contain `<orgName>` |
| `<date type="decision">`, `<date type="enacted">` | date a decision was issued / a statute was enacted |
| `<bibl type="legislation">`, `<bibl type="decision">` | statute / court decision citation; no type for ordinary references |
| `<title level="a" type="caseName">` | case short-name ("GS Media/Sanoma") |
| `<title level="m" type="legislation" key="UrhG">` | statute title, `@key` = short key |
| `<title ... subtype="short">` | short form of a title already tagged in full in the same `<bibl>`; same `@key` as the full form |
| `<ref type="...">` | intra-footnote reference, see below |
| `<seg type="citationContext">` | signal phrase / comment introducing a citation, see below |
| `<quote>` | direct quotation supported by the `<bibl>`; no attributes; leave quotation marks and punctuation as they are in the text |

### Values: `@when`, `@n`, `@from`/`@to`

- Bare year or bare number: no attribute (`<date>2019</date>`, `<biblScope unit="volume">3</biblScope>`).
- Any other date form (`8.9.2016`, "17 April 2019"): add ISO `@when`; omit only if not resolvable ("n.d.").
- Non-numeric or mixed content (Roman numeral, attached `Rn.`/`§`/`Abs.`/`lit.`): add normalized `@n` (`<biblScope unit="volume" n="2">II</biblScope>`).
- Real range: `@from` + `@to`. Only the start given (first page of an article): `@from` only. Never the same value in both.
- `f.`/`et seq.`: `@from` = cited unit, `@to` = next unit. `ff.`/`et seqq.`: `@from` only. Applies to every unit.
- Multi-day `<date>`: `@from` + `@to` (ISO, one per end of the range) instead of `@when`; text content stays as in the source. `<date from="2012-03-01" to="2012-03-02">1-2.03.2012</date>`. `@when` and `@from`/`@to` are mutually exclusive.

### Pinpoints (`<citedRange>`)

| `@unit` | Matches |
| --- | --- |
| `section` | `§ 19a`, `Art. 5`, `Sec. 2` |
| `subSection` | `Abs. 2` |
| `sentence` | `S. 1`, `Satz 1` |
| `number` | `Nr. 3`, `par. 254` |
| `letter` | `lit. b`, `Buchst. b` |
| `margin` | `Tz. 24`, `Rn. 20`, `Rdnr. 7` |
| `recital` | `ErwGr. 21` |
| `page` | pinpoint page, e.g. `240` in `233 (240)` or `233, at 240`; `498` in `ZGE 2016, 482, 498` |

- "p."/"pp."/"S." stay outside the tag; `Rn.`, `§`, `Abs.`, `lit.` and `f.`/`ff.` stay inside.
- A page (range) that is the full extent of an article/chapter/entry inside its container is `<biblScope>`; one that locates a passage in a work whose extent is given separately, or any `f.`/`ff.`/`et seq.` pinpoint, is `<citedRange>`.
- A work without pagination (decision cited by marginal number) has only `<citedRange>`.

```xml
<biblScope unit="page" from="233" to="250">233–250</biblScope>, at <citedRange unit="page">240</citedRange>
<citedRange unit="page" from="233" to="234">233 f.</citedRange>
<citedRange unit="margin" from="12">Rn. 12 ff.</citedRange>
<bibl type="legislation"><citedRange unit="section" n="19a">§ 19a</citedRange> <citedRange unit="subSection" n="2">Abs. 2</citedRange> <title level="m" type="legislation" key="UrhG">UrhG</title></bibl>
```

### Titles

- Translated title: original and translation are two `<title>`s with the same `@level`, each with `@xml:lang` (BCP 47); brackets outside. No `@xml:lang` without a translation.
- Formal statute titles with embedded data: keep one `<title>` in original word order and nest `<idno>`, `<authority>`, `<date>`, `<ref type="work">` inside it. Where the source gives authority, date, identifier as separate fields, tag them as siblings, not nested.
- `<ref type="work">`: passing mention of another work without its own citation (optional).

```xml
<bibl type="legislation"><title level="m" type="legislation" key="DSM Directive">Directive (EU) <idno type="actNumber">2019/790</idno> of <authority type="legislature">the European Parliament and of the Council</authority> of <date type="enacted" when="2019-04-17">17 April 2019</date> on copyright … amending Directives <ref type="work">96/9/EC</ref> and <ref type="work">2001/29/EC</ref></title>, <title level="m" type="legislation" subtype="short" key="DSM Directive">DSM Directive</title>, <ptr type="web">https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:<idno type="CELEX">32019L0790</idno></ptr>.</bibl>
```

### URLs and DOIs

- An identifier that occurs only inside a URL is tagged in place with a nested `<idno>` in the `<ptr>`; never repeated outside.
- DOI inside a URL and no separate `<idno type="DOI">` in the reference: nest `<idno type="DOI">` in the `<ptr>`. With a separate DOI `<idno>`: leave the URL plain.

```xml
<ptr type="web" target="https://doi.org/10.1162/coli_a_00345">https://doi.org/<idno type="DOI">10.1162/coli_a_00345</idno></ptr>
```

### German legal commentaries

- Commentary = `<title level="m">` (incl. editor names that form its name: `Dreier/Schulze`, `Grüneberg, BGB`). Entry heading (`UrhG § 60c`, `§ 985`) = `<title level="a">`. Marginal number = `<citedRange unit="margin">`. Commentator (Bearbeiter, optional) = the only `<author>`. No `type="legislation"`, no section split of the heading.
- Slash form: commentator is the name after the last slash.

```xml
<bibl><author>Westermann</author>, in: <title level="m">MünchKomm-BGB</title>, <title level="a">§ 985</title> <citedRange unit="margin" n="12">Rn. 12</citedRange></bibl>
<bibl><title level="m">Dreier/Schulze</title>/<author>Dreier</author>, <edition n="7">7. Aufl.</edition> <date type="publication">2022</date>, <title level="a">UrhG § 60c</title> <citedRange unit="margin" n="1">Rn. 1</citedRange>.</bibl>
```

### Mentions of legal texts

Tag a statute only when the `<bibl>` cites it as the source. A statute merely mentioned inside a signal phrase or a title stays untagged.

### Intra-footnote references (`<ref type="...">`)

| `@type` | Examples |
| --- | --- |
| `precedingWork` | *supra*, *above*, *oben*, `id.`, `ibid.`, `op. cit.`, `cit.`, `a.a.O.` |
| `subsequentWork` | *infra*, *below* |
| `precedingAuthor` | `ders.`, `idem` |
| `footnote` (with `@n`) | `n. 7`, `N. 22`, `note 24` |
| `work` | passing mention of an uncited work |

Adjacent but distinct devices are separate `<ref>`s. A pointer to a section of the citing article itself ("See infra, section 3.2.") stays plain text.

```xml
<author>Kaiser</author> (<ref type="precedingWork">oben</ref> <ref type="footnote" n="22">N. 22</ref>) <biblScope unit="page">89</biblScope>
<bibl><ref type="precedingAuthor">Ders.</ref>, <ref type="precedingWork">a.a.O.</ref>, S. <citedRange unit="page">123</citedRange>.</bibl>
```

### Signal phrases (`<seg type="citationContext">`)

- Covers all text from the end of the preceding citation (or the label) up to where the cited work begins (author, editor or title), incl. the signal word ("see", "cf.", "vgl.", "anderer Ansicht") and any further sentences.
- Plain text only inside: no tags for names or titles in it.
- Shared by several citations: only in the first `<bibl>`.
- A separate phrase introducing a quotation is its own `<seg>`.

```xml
<!-- correct -->
<seg type="citationContext">In the Polish literature -cf.</seg> <editor>Z. Kmieciak</editor>, …
<!-- incorrect -->
In the Polish literature <seg type="citationContext">-cf.</seg> <editor>Z. Kmieciak</editor>, …
```

### Example

```xml
<bibl><label>9</label> <seg type="citationContext">See e.g.:</seg> <authority type="court">Inter-American Court of Human Rights</authority>, <date type="decision" when="2020-02-16">judgment of 16 February 2020</date>, <title level="a" type="caseName">Indigenous Communities of the Lhaka Honhat (Our Land) Association v. Argentina</title>, <citedRange unit="number" n="254">par. 254</citedRange>, <seg type="citationContext">quoting the amicus curiae intervention of the former UN Special Rapporteur on the Right to Food, De Schutter:</seg> <quote>«Many indigenous peoples understand the right to adequate food as a collective right. …»</quote> The cultural value of food is recognized … (ICCPR). See infra, section 3.2.</bibl>
<bibl><author>Cook</author>, <ref type="precedingWork">supra</ref> <ref type="footnote" n="12">note 12</ref>, <citedRange unit="page">170</citedRange>.</bibl>
<bibl><seg type="citationContext">cf.</seg> <author>Carli N. Conklin</author>, <title level="a">The Origins of the Pursuit of Happiness</title>, <title level="j">7 Wash. U. Juris. Rev.</title> <biblScope unit="page" from="195">195</biblScope>, <citedRange unit="page">200</citedRange> (<date type="publication">2015</date>) (selecting for use the first edition, as does the present article);</bibl>
```
