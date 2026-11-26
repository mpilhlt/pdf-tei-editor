# Archived PDF notice reduced to an icon

The PDF viewer statusbar showed "Original PDF (before text recognition)" with a clock icon when the loaded version was made from the PDF as it was before text recognition replaced it (#924). The text was not informative for most users and took statusbar space.

`PdfViewerPlugin.setArchivedPdfIndicator()` now adds only the `clock-history` icon (warning color) wrapped in an `sl-tooltip` with the text "This PDF has a text layer which has been replaced in later versions". `StatusText` renders its tooltip as a native `title`, so the widget is an `sl-tooltip` element added to the statusbar directly. The user manual (extraction workflow) describes the icon; no manual screenshot showed the notice.
