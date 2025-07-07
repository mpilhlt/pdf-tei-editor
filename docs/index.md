# PDF-TEI Editor

A viewer/editor web app to compare the PDF source and TEI extraction/annotation results.

Authors/Contributors:
- Christian Boulanger, Max Planck Institute for Legal History and Legal Theory

This repo is part of the ["Legal Theory Knowledge Graph" project](https://www.lhlt.mpg.de/2514927/03-boulanger-legal-theory-graph) at the Max Planck Institute of Legal History and Legal Theory.

## Purpose

The purpose of this application is to support the creation of a gold standard dataset of TEI documents that contain extracted information from PDF documents. The main target is reference extraction, i.e. the extraction of citation data, or, less technical, the answer to the question which bibliographic references are cited by a given PDF.

Highly efficient tools exist for this tasks when dealing with english language literature containing well-structured bibliographies, such as [GROBID](https://grobid.readthedocs.io/). However, these tools perform poorly when faced with literature in law and the humanities, which typically rely on footnotes for providing reference information. The reason is that these references are often incomplete or mixed with additional commentary. This made these type of references difficult to parse for tradional parsing methods based on pattern matching and machine learning. 

Large Lange Models (LLMs), or more recently, Large Vision Models (LVMs) have changed this situation, as they "understand" the textual semantics and outperform the existing tools even without optimizing for the specific use case. However,  results generated using these models cannot be relied on without prior rigorous evaluation and validation. This requires a sufficiently large dataset of labelled data reviewed by human experts. This dataset can then also be used for finetuning models. 

Creating this dataset is a time-consuming and often tedious process. This is where tools like the present one come in. This web application is meant to make the manual validation and correction of gold standard files easier and faster. It provides a graphical user interface for the [LLamore](https://github.com/mpilhlt/llamore) library, which provides an adapter to any commercial or open weights model that it can connect to and uses them to extract references from PDFs. 

The app features a variety of tools work with, and enhance the extracted data, to compare different version, and to selectively merge diffs between these versions. If the XML document in the editor contains an URL with the location of a XSD schema file, the XML document is automatically validated. When a selection XPath is specified, the editor allows you to navigate between all nodes that match the XPath, which will typically be the nodes that contain the main data records, i.e, the `<tei:biblStruct>` nodes. 

More information is in preparation.


