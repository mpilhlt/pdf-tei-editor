/**
 * Utility functions for processing file data across different file selection components
 * This module provides reusable functionality for filtering, grouping, and processing fileData
 */

/**
 * Access control metadata
 * @typedef {object} AccessControl
 * @property {string} editability - Edit permissions ("editable", etc.)
 * @property {string|null} owner - Owner of the file
 * @property {string[]} status_values - Available status values
 * @property {string} visibility - Visibility setting ("public", etc.)
 */

/**
 * Metadata retrieved from the <teiHeader>
 * @typedef {object} TeiHeaderMetaData
 * @property {string} author - Document author
 * @property {string} date - Publication date
 * @property {string} doi - DOI identifier
 * @property {string} fileref - File reference identifier
 * @property {string} last_status - Last known status
 * @property {string} last_update - ISO timestamp of last update
 * @property {string|null} last_updated_by - User who last updated
 * @property {string} title - Document title
 * @property {string} [variant_id] - Optional variant identifier
 */

/**
 * @typedef {TeiHeaderMetaData & {access_control: AccessControl}} FileMetadata
 */

/**
 * @typedef {object} BaseFileData
 * @property {string} [collection] - Collection name
 * @property {string} hash - Unique hash identifier
 * @property {string} [path] - File system path (only for debugging)
 */


/**
 * @typedef {BaseFileData & {
 *   is_locked?: boolean,
 *   label: string,
 *   last_status: string,
 *   last_update: string,
 *   metadata: FileMetadata,
 *   variant_id?: string
 * }} TeiFileData - TEI file with full metadata
 */

/**
 * @typedef {BaseFileData} PdfFileData - PDF file reference (minimal structure)
 */

/**
 * @typedef {TeiFileData} VersionFileData - Version file extends TEI file with lock status
 */

/**
 * @typedef {object} FileListItem
 * @property {string} author - Document author
 * @property {string} collection - Collection name
 * @property {string} date - Publication date
 * @property {string} doi - DOI identifier
 * @property {string} fileref - File reference identifier
 * @property {TeiFileData[]} gold - Array of gold standard TEI files
 * @property {string} id - Unique file identifier
 * @property {string} label - Human-readable label for the file
 * @property {PdfFileData} pdf - PDF file data
 * @property {string} title - Document title
 * @property {VersionFileData[]} versions - Array of version files
 */

/**
 * @typedef {object} LookupItem
 * @property {"version" | "gold"} type
 * @property {TeiFileData} item
 * @property {FileListItem} file
 * @property {string} label
 */

// Global lookup index for efficient hash-based queries
let hashLookupIndex = new Map();

/**
 * Creates a lookup index that maps hash values directly to items
 * @param {FileListItem[]} fileData - The file data array
 * @returns {Map<string, LookupItem>} Map of hash to item with metadata
 */
export function createHashLookupIndex(fileData) {
  const index = new Map();
  
  fileData.forEach((file) => {
    // Index PDF hash
    if (file.pdf && file.pdf.hash) {
      index.set(file.pdf.hash, {
        type: 'pdf',
        item: file.pdf,
        file: file,
        label: file.label
      });
    }
    
    // Index gold entries
    if (file.gold) {
      file.gold.forEach((gold) => {
        if (gold.hash) {
          index.set(gold.hash, {
            type: 'gold',
            item: gold,
            file: file,
            label: gold.label || file.label
          });
        }
      });
    }
    
    // Index version entries
    if (file.versions) {
      file.versions.forEach((version) => {
        if (version.hash) {
          index.set(version.hash, {
            type: 'version',
            item: version,
            file: file,
            label: version.label || file.label
          });
        }
      });
    }
  });
  
  // Store globally for use by other functions
  hashLookupIndex = index;
  return index;
}

/**
 * Gets file data entry from hashLookupIndex based on any hash (PDF or XML)
 * @param {string} hash - Hash of any file (PDF, gold, or version)
 * @returns {LookupItem|null} Entry object with {type, item, file, label} or null if not found
 */
export function getFileDataByHash(hash) {
  if (!hash) return null;

  if (!hashLookupIndex || hashLookupIndex.size === 0) {
    throw new Error('Hash lookup index not initialized. Call createHashLookupIndex() first.');
  }

  return hashLookupIndex.get(hash) || null;
}

/**
 * Gets document title/label from fileData based on any hash (PDF or XML)
 * @param {string} hash - Hash of any file (PDF, gold, or version)
 * @returns {string} Document title/label or empty string if not found
 */
export function getDocumentTitle(hash) {
  const entry = getFileDataByHash(hash);
  return entry?.label || '';
}

/**
 * Extracts all unique variants from file data
 * @param {FileListItem[]} fileData - The file data array
 * @returns {Set<string>} Set of unique variant IDs
 */
export function extractVariants(fileData) {
  const variants = new Set();
  
  fileData.forEach(file => {
    // Add variant_id from gold entries
    if (file.gold) {
      file.gold.forEach(gold => {
        if (gold.variant_id) {
          variants.add(gold.variant_id);
        }
      });
    }
    // Add variant_id from versions
    if (file.versions) {
      file.versions.forEach(version => {
        if (version.variant_id) {
          variants.add(version.variant_id);
        }
      });
    }
  });
  
  return variants;
}

/**
 * Filters file data by variant selection
 * @param {FileListItem[]} fileData - The file data array
 * @param {string|null} variant - Selected variant ("", "none", or variant ID)
 * @returns {FileListItem[]} Filtered file data
 */
export function filterFileDataByVariant(fileData, variant) {
  if (variant === "none") {
    // Show only files without variant_id in gold or versions
    return fileData.filter(file => {
      const hasGoldVariant = file.gold && file.gold.some(g => !!g.variant_id);
      const hasVersionVariant = file.versions && file.versions.some(v => !!v.variant_id);
      return !hasGoldVariant && !hasVersionVariant;
    });
  } else if (variant && variant !== "") {
    // Show only files with the selected variant_id (in gold or versions)
    return fileData.filter(file => {
      const matchesGold = file.gold && file.gold.some(g => g.variant_id === variant);
      const matchesVersion = file.versions && file.versions.some(v => v.variant_id === variant);
      return matchesGold || matchesVersion;
    });
  }
  // If variant is "" (All), show all files
  return fileData;
}

/**
 * Filters file data by label text search
 * @param {FileListItem[]} fileData - The file data array
 * @param {string} searchText - Text to search for in labels
 * @returns {FileListItem[]} Filtered file data
 */
export function filterFileDataByLabel(fileData, searchText) {
  if (!searchText || searchText.trim() === '') {
    return fileData;
  }
  
  const search = searchText.toLowerCase();
  return fileData.filter(file => 
    file.label && file.label.toLowerCase().includes(search)
  );
}

/**
 * Groups file data by collection
 * @param {FileListItem[]} fileData - The file data array
 * @returns {Record<string, FileListItem[]>} Grouped files by collection name
 */
export function groupFilesByCollection(fileData) {
  /** @type Record<string, FileListItem[]> */
  const groups = {}
  return fileData.reduce((groups, file) => {
    const collection_name = file.collection;
    if (collection_name) {
      groups[collection_name] ||= []
      groups[collection_name].push(file);
    }
    return groups;
  }, groups);
}

/**
 * Filters versions and gold entries by variant
 * @param {FileListItem} file - File object containing versions and gold
 * @param {string|null} variant - Selected variant
 * @returns {{ versionsToShow: TeiFileData[], goldToShow:TeiFileData[] }} Object with filtered versions and gold arrays
 */
export function filterFileContentByVariant(file, variant) {
  let versionsToShow = file.versions || [];
  let goldToShow = file.gold || [];
  
  if (variant === "none") {
    // Show only entries without variant_id
    versionsToShow = file.versions ? file.versions.filter(version => !version.variant_id) : [];
    goldToShow = file.gold ? file.gold.filter(gold => !gold.variant_id) : [];
  } else if (variant && variant !== "") {
    // Show only entries with the selected variant_id
    versionsToShow = file.versions ? file.versions.filter(version => version.variant_id === variant) : [];
    goldToShow = file.gold ? file.gold.filter(gold => gold.variant_id === variant) : [];
  }
  // If variant is "" (All), show all entries (already assigned above)
  
  return { versionsToShow, goldToShow };
}

/**
 * Finds a matching gold file based on variant selection
 * @param {FileListItem} file - File object containing gold entries
 * @param {string|null} variant - Selected variant
 * @returns {TeiFileData|null} Matching gold entry or null
 */
export function findMatchingGold(file, variant) {
  if (!file.gold) return null;
  
  if (variant === "none") {
    // Find gold without variant_id
    return file.gold.find(gold => !gold.variant_id) || null;
  } else if (variant && variant !== "") {
    // Find gold with matching variant_id
    return file.gold.find(gold => gold.variant_id === variant) || null;
  } else {
    // No variant filter - use first gold file
    return file.gold[0] || null;
  }
}

/**
 * Finds the collection for a given file hash by searching through file data
 * @param {FileListItem[]} fileData - The file data array
 * @param {string} hash - Hash of the file to find
 * @returns {string|null} Collection name or null if not found
 */
export function findCollectionByHash(fileData, hash) {
  for (const file of fileData) {
    const hasGoldMatch = file.gold && file.gold.some(gold => gold.hash === hash);
    const hasVersionMatch = file.versions && file.versions.some(version => version.hash === hash);
    
    if (hasGoldMatch || hasVersionMatch || file.pdf.hash === hash) {
      return file.collection;
    }
  }
  return null;
}

/**
 * Finds a file object by PDF hash
 * @param {FileListItem[]} fileData - The file data array  
 * @param {string} pdfHash - Hash of the PDF file
 * @returns {FileListItem|null} File object or null if not found
 */
export function findFileByPdfHash(fileData, pdfHash) {
  return fileData.find(file => file.pdf.hash === pdfHash) || null;
}

/**
 * Finds the corresponding PDF hash and collection for a given XML hash
 * @param {FileListItem[]} fileData - The file data array
 * @param {string} xmlHash - Hash of the XML file (gold or version)
 * @returns {{pdfHash: string, collection: string}|null} Object with {pdfHash, collection} or null if not found
 */
export function findCorrespondingPdf(fileData, xmlHash) {
  for (const file of fileData) {
    // Check if this XML is in the gold entries
    const hasGoldMatch = file.gold && file.gold.some(gold => gold.hash === xmlHash);
    // Check if this XML is in the versions
    const hasVersionMatch = file.versions && file.versions.some(version => version.hash === xmlHash);
    
    if (hasGoldMatch || hasVersionMatch) {
      return {
        pdfHash: file.pdf.hash,
        collection: file.collection
      };
    }
  }
  return null;
}