/**
 * TEI XML Diff Viewer
 *
 * Displays side-by-side comparison of two XML documents with syntax highlighting.
 */

(function (exports) {
    'use strict';

    /**
     * Extract line number from data-line attribute in XML content
     *
     * @param {string} content - XML line content
     * @returns {number|null} Extracted line number or null if not found
     */
    function extractLineMarker(content) {
        const match = content.match(/data-line="(\d+)"/);
        return match ? parseInt(match[1], 10) : null;
    }

    /**
     * Strip data-line attributes from content for display
     *
     * @param {string} content - XML line content
     * @returns {string} Content without data-line attributes
     */
    function stripLineMarkers(content) {
        return content.replace(/\s*data-line="\d+"/g, '');
    }

    /**
     * Strip data-line attributes from entire XML string before diffing
     *
     * In semantic mode, data-line attributes are used for navigation but should not
     * affect diff results. This function removes them so identical content with
     * different line numbers doesn't create false differences.
     *
     * @param {string} xml - XML string with data-line attributes
     * @returns {string} XML string without data-line attributes
     */
    function stripLineMarkersForDiff(xml) {
        return xml.replace(/\s*data-line="\d+"/g, '');
    }

    /**
     * Get display line number in full document
     *
     * @param {number} diffLineNum - Line number from diff operation (1-indexed)
     * @param {number} lineOffset - Offset of content element in full document
     * @param {boolean} useSemanticMode - Whether using semantic mode
     * @returns {number|string} Line number in full document, or empty string if semantic mode
     */
    function getDisplayLineNumber(diffLineNum, lineOffset, useSemanticMode) {
        if (!useSemanticMode) {
            // All differences mode: show actual line numbers
            return lineOffset + diffLineNum - 1;
        }

        // Semantic mode: don't show line numbers in gutter (extracted from data-line instead)
        return '';
    }

    /**
     * Split diff part into lines, preserving empty lines except trailing empty line
     *
     * @param {string} text - Text to split
     * @returns {Array<string>} Lines
     */
    function splitDiffLines(text) {
        return text.split('\n').filter((line, idx, arr) => {
            // Keep all lines except the final empty line from split
            return idx < arr.length - 1 || line !== '';
        });
    }

    /**
     * Compute diff blocks between two XML documents
     *
     * @param {Object} config - Configuration object
     * @param {string} config.xml1Original - Original XML of first document
     * @param {string} config.xml2Original - Original XML of second document
     * @param {string} config.xml1Preprocessed - Preprocessed XML of first document
     * @param {string} config.xml2Preprocessed - Preprocessed XML of second document
     * @param {number} config.lineOffset1 - Line offset of content element in full document 1
     * @param {number} config.lineOffset2 - Line offset of content element in full document 2
     * @param {boolean} config.useSemanticMode - Whether to use semantic diff mode
     * @returns {Array<Object>} Array of diff blocks
     */
    function computeDiffBlocks(config) {
        const {
            xml1Original,
            xml2Original,
            xml1Preprocessed,
            xml2Preprocessed,
            lineOffset1,
            lineOffset2,
            useSemanticMode = false
        } = config;

        // Choose XML to diff based on mode
        let xml1ForDiff = useSemanticMode ? xml1Preprocessed : xml1Original;
        let xml2ForDiff = useSemanticMode ? xml2Preprocessed : xml2Original;

        // In semantic mode, strip data-line attributes before diffing to avoid false differences
        // when only line numbers differ. Keep original preprocessed strings for line number extraction.
        const xml1WithMarkers = xml1Preprocessed;  // Original with data-line for extraction
        const xml2WithMarkers = xml2Preprocessed;

        if (useSemanticMode) {
            xml1ForDiff = stripLineMarkersForDiff(xml1ForDiff);
            xml2ForDiff = stripLineMarkersForDiff(xml2ForDiff);
        }

        const diff = (typeof Diff !== 'undefined') ? Diff.diffLines(xml1ForDiff, xml2ForDiff) : [];

        const diffBlocks = [];
        let line1 = 1;  // Current line in xml1ForDiff (stripped version)
        let line2 = 1;  // Current line in xml2ForDiff (stripped version)

        // Split preprocessed strings with markers for line number extraction
        const lines1WithMarkers = useSemanticMode ? xml1WithMarkers.split('\n') : [];
        const lines2WithMarkers = useSemanticMode ? xml2WithMarkers.split('\n') : [];

        diff.forEach(part => {
            const lines = splitDiffLines(part.value);

            if (part.added || part.removed) {
                // Create new diff block if needed
                if (!diffBlocks.length || diffBlocks[diffBlocks.length - 1].closed) {
                    const startLine1 = getDisplayLineNumber(line1, lineOffset1, useSemanticMode);
                    const startLine2 = getDisplayLineNumber(line2, lineOffset2, useSemanticMode);

                    diffBlocks.push({
                        left: [],
                        right: [],
                        startLine1,
                        startLine2,
                        closed: false
                    });
                }

                const currentBlock = diffBlocks[diffBlocks.length - 1];

                if (part.removed) {
                    // Lines removed from doc1
                    lines.forEach((diffContent, i) => {
                        const diffLineNum = line1 + i;
                        const displayLineNum = getDisplayLineNumber(diffLineNum, lineOffset1, useSemanticMode);

                        // In semantic mode, extract line number from original preprocessed string with markers
                        let originalLineNum = null;
                        let displayContent = diffContent;

                        if (useSemanticMode) {
                            // Get corresponding line from original preprocessed string (1-indexed)
                            const lineWithMarker = lines1WithMarkers[diffLineNum - 1];
                            if (lineWithMarker) {
                                originalLineNum = extractLineMarker(lineWithMarker);
                            }
                            // Display content is already stripped (from diff)
                            displayContent = diffContent;
                        }

                        currentBlock.left.push({
                            number: displayLineNum,
                            content: displayContent,
                            originalLine: originalLineNum,
                            type: 'removed'
                        });
                    });
                    line1 += lines.length;

                } else if (part.added) {
                    // Lines added to doc2
                    lines.forEach((diffContent, i) => {
                        const diffLineNum = line2 + i;
                        const displayLineNum = getDisplayLineNumber(diffLineNum, lineOffset2, useSemanticMode);

                        // In semantic mode, extract line number from original preprocessed string with markers
                        let originalLineNum = null;
                        let displayContent = diffContent;

                        if (useSemanticMode) {
                            // Get corresponding line from original preprocessed string (1-indexed)
                            const lineWithMarker = lines2WithMarkers[diffLineNum - 1];
                            if (lineWithMarker) {
                                originalLineNum = extractLineMarker(lineWithMarker);
                            }
                            // Display content is already stripped (from diff)
                            displayContent = diffContent;
                        }

                        currentBlock.right.push({
                            number: displayLineNum,
                            content: displayContent,
                            originalLine: originalLineNum,
                            type: 'added'
                        });
                    });
                    line2 += lines.length;
                }
            } else {
                // Unchanged section - advance line counters and close current block
                line1 += lines.length;
                line2 += lines.length;

                if (diffBlocks.length && !diffBlocks[diffBlocks.length - 1].closed) {
                    diffBlocks[diffBlocks.length - 1].closed = true;
                }
            }
        });

        return diffBlocks;
    }

    /**
     * Regroup diff blocks by original line numbers in semantic mode
     *
     * In semantic mode, the diff operates on preprocessed XML which has a different
     * structure than the original. We need to group changes by their original line
     * numbers so that related changes appear together.
     *
     * @param {Array<Object>} diffBlocks - Diff blocks from computeDiffBlocks
     * @returns {Array<Object>} Regrouped diff blocks
     */
    function regroupByOriginalLines(diffBlocks) {
        const newBlocks = [];

        for (const block of diffBlocks) {
            // Collect all original line numbers from this block
            const leftLines = new Set(block.left.map(item => item.originalLine).filter(n => n !== null));
            const rightLines = new Set(block.right.map(item => item.originalLine).filter(n => n !== null));

            // If no line numbers available, keep block as-is
            if (leftLines.size === 0 && rightLines.size === 0) {
                newBlocks.push(block);
                continue;
            }

            // Group items by original line number
            const lineGroups = new Map();

            for (const item of block.left) {
                const lineNum = item.originalLine || 'none';
                if (!lineGroups.has(lineNum)) {
                    lineGroups.set(lineNum, { left: [], right: [] });
                }
                lineGroups.get(lineNum).left.push(item);
            }

            for (const item of block.right) {
                const lineNum = item.originalLine || 'none';
                if (!lineGroups.has(lineNum)) {
                    lineGroups.set(lineNum, { left: [], right: [] });
                }
                lineGroups.get(lineNum).right.push(item);
            }

            // Convert groups to separate blocks, sorted by line number
            const sortedLineNums = Array.from(lineGroups.keys()).sort((a, b) => {
                if (a === 'none') return 1;
                if (b === 'none') return -1;
                return a - b;
            });

            for (const lineNum of sortedLineNums) {
                const group = lineGroups.get(lineNum);
                newBlocks.push({
                    left: group.left,
                    right: group.right,
                    startLine1: '',
                    startLine2: '',
                    closed: true
                });
            }
        }

        return newBlocks;
    }

    /**
     * Initialize the diff viewer UI
     *
     * @param {Object} config - Configuration object
     * @param {string} config.xml1Original - Original XML of first document
     * @param {string} config.xml2Original - Original XML of second document
     * @param {string} config.xml1Preprocessed - Preprocessed XML of first document
     * @param {string} config.xml2Preprocessed - Preprocessed XML of second document
     * @param {Object} config.lineMapping1 - Map of preprocessed line numbers to original line numbers (doc 1)
     * @param {Object} config.lineMapping2 - Map of preprocessed line numbers to original line numbers (doc 2)
     * @param {number} config.lineOffset1 - Line offset of content element in full document 1
     * @param {number} config.lineOffset2 - Line offset of content element in full document 2
     * @param {string} config.stableId1 - Stable ID of first document
     * @param {string} config.stableId2 - Stable ID of second document
     */
    function initDiffViewer(config) {
        const {
            xml1Original,
            xml2Original,
            xml1Preprocessed,
            xml2Preprocessed,
            lineMapping1,
            lineMapping2,
            lineOffset1,
            lineOffset2,
            stableId1,
            stableId2
        } = config;

        /**
         * Apply syntax highlighting to a line of XML
         */
        function highlightXml(line) {
            if (!line) return '';
            // Use Prism to highlight XML (markup language)
            return Prism.highlight(line, Prism.languages.markup, 'markup');
        }

        /**
         * Crop line if very long, keeping context around differences
         */
        function cropLine(line, isChanged) {
            if (!isChanged || line.length < 80) {
                return highlightXml(line);
            }

            // For changed lines, show start and end with ellipsis in middle if very long
            const start = line.substring(0, 40);
            const end = line.substring(line.length - 40);

            return highlightXml(start) + '<span class="ellipsis">&lt;⋯&gt;</span>' + highlightXml(end);
        }

        /**
         * Add click handler to diff line
         */
        function addClickHandler(lineDiv, stableId, lineNumber) {
            lineDiv.addEventListener('click', async () => {
                if (!window.sandbox) {
                    alert('Sandbox API not available - open this page via plugin');
                    return;
                }

                try {
                    await window.sandbox.openDocumentAtLine(stableId, lineNumber, 0);
                } catch (error) {
                    console.error('Failed to open document:', error);
                    alert('Failed to open document: ' + error.message);
                }
            });

            // Add title attribute for hint
            lineDiv.title = 'Click to open document at line ' + lineNumber;
        }

        /**
         * Render diff blocks to the DOM
         */
        function renderDiffBlocks(useSemanticMode = false) {
            // Compute diff blocks
            const diffBlocks = computeDiffBlocks({
                xml1Original,
                xml2Original,
                xml1Preprocessed,
                xml2Preprocessed,
                lineMapping1,
                lineMapping2,
                lineOffset1,
                lineOffset2,
                useSemanticMode
            });

            // Render summary
            const summary = document.getElementById('summary');
            if (diffBlocks.length === 0) {
                summary.textContent = 'No differences found.';
                document.getElementById('diffResults').innerHTML =
                    '<div class="empty-message">The documents are identical.</div>';
                return;
            }

            summary.textContent = `Found ${diffBlocks.length} difference block(s)`;

            // Render diff blocks
            const resultsContainer = document.getElementById('diffResults');
            diffBlocks.forEach((block, idx) => {
                const blockDiv = document.createElement('div');
                blockDiv.className = 'diff-block';

                const header = document.createElement('div');
                header.className = 'diff-block-header';
                // Show line numbers only if they're not empty strings
                if (block.startLine1 !== '' && block.startLine2 !== '') {
                    header.textContent = `Difference #${idx + 1} - Lines ${block.startLine1} ↔ ${block.startLine2}`;
                } else {
                    header.textContent = `Difference #${idx + 1}`;
                }
                blockDiv.appendChild(header);

                const container = document.createElement('div');
                container.className = 'diff-container';

                // Left pane
                const leftPane = document.createElement('div');
                leftPane.className = 'diff-pane';
                block.left.forEach(item => {
                    const lineDiv = document.createElement('div');
                    lineDiv.className = 'diff-line diff-' + item.type;
                    lineDiv.innerHTML = `<span class="line-number">${item.number}</span><span class="line-content">${cropLine(item.content, true)}</span>`;

                    // Add click handler: use originalLine if available (semantic mode), otherwise use number
                    const clickLineNum = item.originalLine || item.number;
                    if (clickLineNum) {
                        addClickHandler(lineDiv, stableId1, clickLineNum);
                    }

                    leftPane.appendChild(lineDiv);
                });
                container.appendChild(leftPane);

                // Right pane
                const rightPane = document.createElement('div');
                rightPane.className = 'diff-pane';
                block.right.forEach(item => {
                    const lineDiv = document.createElement('div');
                    lineDiv.className = 'diff-line diff-' + item.type;
                    lineDiv.innerHTML = `<span class="line-number">${item.number}</span><span class="line-content">${cropLine(item.content, true)}</span>`;

                    // Add click handler: use originalLine if available (semantic mode), otherwise use number
                    const clickLineNum = item.originalLine || item.number;
                    if (clickLineNum) {
                        addClickHandler(lineDiv, stableId2, clickLineNum);
                    }

                    rightPane.appendChild(lineDiv);
                });
                container.appendChild(rightPane);

                blockDiv.appendChild(container);
                resultsContainer.appendChild(blockDiv);
            });
        }

        // Initialize with current toggle state (handles browser form persistence)
        const semanticToggle = document.getElementById('semanticToggle');
        renderDiffBlocks(semanticToggle.checked);

        // Handle toggle change
        document.getElementById('semanticToggle').addEventListener('change', (e) => {
            const useSemanticMode = e.target.checked;
            // Clear previous results
            document.getElementById('diffResults').innerHTML = '';
            // Recompute with new mode
            renderDiffBlocks(useSemanticMode);
        });
    }

    // Export functions for testing (Node.js) and browser use
    if (typeof exports !== 'undefined') {
        exports.computeDiffBlocks = computeDiffBlocks;
        exports.regroupByOriginalLines = regroupByOriginalLines;
        exports.initDiffViewer = initDiffViewer;
    }
    if (typeof window !== 'undefined') {
        window.initDiffViewer = initDiffViewer;
    }

})(typeof exports !== 'undefined' ? exports : {});
