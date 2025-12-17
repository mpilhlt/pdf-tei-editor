/**
 * TEI XML Diff Viewer
 *
 * Displays side-by-side comparison of two XML documents with syntax highlighting.
 */

(function(exports) {
    'use strict';

    /**
     * Compute diff blocks between two XML documents
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
     * @param {boolean} config.useSemanticMode - Whether to use semantic diff mode
     * @returns {Array<Object>} Array of diff blocks
     */
    function computeDiffBlocks(config) {
        const {
            xml1Original,
            xml2Original,
            xml1Preprocessed,
            xml2Preprocessed,
            lineMapping1,
            lineMapping2,
            lineOffset1,
            lineOffset2,
            useSemanticMode = false
        } = config;

        // Split original XML into lines (for display)
        const lines1Original = xml1Original.split('\n');
        const lines2Original = xml2Original.split('\n');

        // Choose diff mode based on toggle
        // Semantic mode: diff preprocessed XML (ignores configured attributes/tags)
        // All mode: diff original XML (shows all differences)
        const xml1ForDiff = useSemanticMode ? xml1Preprocessed : xml1Original;
        const xml2ForDiff = useSemanticMode ? xml2Preprocessed : xml2Original;
        const diff = (typeof Diff !== 'undefined') ? Diff.diffLines(xml1ForDiff, xml2ForDiff) : [];

        let diffBlocks = [];
        let line1 = 1;  // Current line counter (preprocessed or original depending on mode)
        let line2 = 1;

        diff.forEach(part => {
            const lines = part.value.split('\n').filter((l, i, arr) => {
                // Keep empty lines except the last one (from split)
                return i < arr.length - 1 || l !== '';
            });

            if (part.added || part.removed) {
                // Found a difference - create diff block
                // Map to original line numbers if in semantic mode
                let startLine1, startLine2;
                if (useSemanticMode) {
                    const origLine1 = lineMapping1[line1] || line1;
                    const origLine2 = lineMapping2[line2] || line2;
                    startLine1 = lineOffset1 + origLine1 - 1;
                    startLine2 = lineOffset2 + origLine2 - 1;
                } else {
                    startLine1 = lineOffset1 + line1 - 1;
                    startLine2 = lineOffset2 + line2 - 1;
                }

                if (!diffBlocks.length || diffBlocks[diffBlocks.length - 1].closed) {
                    diffBlocks.push({
                        left: [],
                        right: [],
                        startLine1: startLine1,
                        startLine2: startLine2,
                        closed: false
                    });
                }

                const currentBlock = diffBlocks[diffBlocks.length - 1];

                if (part.removed) {
                    lines.forEach((line, i) => {
                        const currentLine = line1 + i;
                        let fullDocLineNum, content;

                        if (useSemanticMode) {
                            // Map preprocessed line to original line
                            const origLine = lineMapping1[currentLine] || currentLine;
                            fullDocLineNum = lineOffset1 + origLine - 1;
                            content = origLine <= lines1Original.length
                                ? lines1Original[origLine - 1]
                                : line;  // Fallback
                        } else {
                            // Direct mapping (no preprocessing)
                            fullDocLineNum = lineOffset1 + currentLine - 1;
                            content = line;
                        }

                        currentBlock.left.push({
                            number: fullDocLineNum,
                            content: content,
                            type: 'removed'
                        });
                    });
                    line1 += lines.length;
                } else if (part.added) {
                    lines.forEach((line, i) => {
                        const currentLine = line2 + i;
                        let fullDocLineNum, content;

                        if (useSemanticMode) {
                            // Map preprocessed line to original line
                            const origLine = lineMapping2[currentLine] || currentLine;
                            fullDocLineNum = lineOffset2 + origLine - 1;
                            content = origLine <= lines2Original.length
                                ? lines2Original[origLine - 1]
                                : line;  // Fallback
                        } else {
                            // Direct mapping (no preprocessing)
                            fullDocLineNum = lineOffset2 + currentLine - 1;
                            content = line;
                        }

                        currentBlock.right.push({
                            number: fullDocLineNum,
                            content: content,
                            type: 'added'
                        });
                    });
                    line2 += lines.length;
                }
            } else {
                // Unchanged section - skip it, but advance line counters
                line1 += lines.length;
                line2 += lines.length;

                // Close current diff block if any
                if (diffBlocks.length && !diffBlocks[diffBlocks.length - 1].closed) {
                    diffBlocks[diffBlocks.length - 1].closed = true;
                }
            }
        });

        return diffBlocks;
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
                header.textContent = `Difference #${idx + 1} - Lines ${block.startLine1} ↔ ${block.startLine2}`;
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

                    // Add click handler
                    addClickHandler(lineDiv, stableId1, item.number);

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

                    // Add click handler
                    addClickHandler(lineDiv, stableId2, item.number);

                    rightPane.appendChild(lineDiv);
                });
                container.appendChild(rightPane);

                blockDiv.appendChild(container);
                resultsContainer.appendChild(blockDiv);
            });
        }

        // Initialize with default mode (all differences)
        renderDiffBlocks(false);

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
        exports.initDiffViewer = initDiffViewer;
    }
    if (typeof window !== 'undefined') {
        window.initDiffViewer = initDiffViewer;
    }

})(typeof exports !== 'undefined' ? exports : {});
