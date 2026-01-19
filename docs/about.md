# About the PDF-TEI Editor

This application has been developed as a part of the ["Legal Theory Knowledge Graph" project](https://www.lhlt.mpg.de/2514927/03-boulanger-legal-theory-graph) at the Max Planck Institute of Legal History and Legal Theory.

## Authors/Contributors

- Christian Boulanger, Max Planck Institute for Legal History and Legal Theory

## Background and Purpose

The purpose of this application is to support the creation of a gold standard dataset of TEI documents that contain extracted information from PDF documents. The main target is reference extraction, i.e. the extraction of citation data, or, less technical, the answer to the question which bibliographic references are cited by a given PDF.

Highly efficient tools exist for this tasks when dealing with English language literature containing well-structured bibliographies. However, these tools perform poorly when faced with literature in law and the humanities, which typically rely on footnotes for providing reference information. The reason is that these footnote references are often incomplete or mixed with commentary, and no training data exists for this kind of literature. Recently, Large Lange Models (LLMs) and Vision Language Models (VLMs) have shown their potential for reference extraction, as they "understand" the textual semantics and outperform the existing tools even without optimizing for the specific use case. However, the results generated using these models cannot be relied on without prior rigorous evaluation and validation. This requires a sufficiently large dataset of labelled data reviewed by human experts. This dataset can then also be used for finetuning models.

Creating datasets for machine learning or model validation is time-consuming and error-prone. This is where tools like the present one come in. This web application is meant to make the manual validation and correction of gold standard files easier and faster, and provides XML schema validation to avoid annotation errors. It currently supports 

- [GROBID](https://grobid.readthedocs.io/en/latest/Introduction/), a machine learning library for extracting, parsing and re-structuring raw documents such as PDF into structured XML/TEI encoded documents
- [LLamore](https://github.com/mpilhlt/llamore), a python library, which provides an adapter to any commercial or open weights model that it can connect to and uses them to extract references from PDFs as TEI.

Due to its modular and pluggable architecture, any extraction engine can be connected.

Bot extraction engines work with a subset of the TEI standard, and produce `<biblStruct>` elements containing structured bibliographic data.
