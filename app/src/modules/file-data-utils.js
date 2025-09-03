/**
 * Utility functions for processing file data across different file selection components
 * This module provides reusable functionality for filtering, grouping, and processing fileData
 */

/**
 * @import { ApplicationState } from '../app.js'
 */

// Global lookup index for efficient hash-based queries
let hashLookupIndex = new Map();

/**
 * Creates a lookup index that maps hash values directly to items
 * @param {Array} fileData - The file data array
 * @returns {Map<string, Object>} Map of hash to item with metadata
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
 * Gets document title/label from fileData based on any hash (PDF or XML)
 * @param {string} hash - Hash of any file (PDF, gold, or version)
 * @returns {string} Document title/label or empty string if not found
 * @throws {Error} If hash lookup index has not been created
 */
export function getDocumentTitle(hash) {
  if (!hash) return '';
  
  if (!hashLookupIndex || hashLookupIndex.size === 0) {
    throw new Error('Hash lookup index not initialized. Call createHashLookupIndex() first.');
  }
  
  const entry = hashLookupIndex.get(hash);
  return entry?.label || '';
}

/**
 * Extracts all unique variants from file data
 * @param {Array} fileData - The file data array
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
 * @param {Array} fileData - The file data array
 * @param {string|null} variant - Selected variant ("", "none", or variant ID)
 * @returns {Array} Filtered file data
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
 * @param {Array} fileData - The file data array
 * @param {string} searchText - Text to search for in labels
 * @returns {Array} Filtered file data
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
 * @param {Array} fileData - The file data array
 * @returns {Object} Grouped files by collection name
 */
export function groupFilesByCollection(fileData) {
  return fileData.reduce((groups, file) => {
    const collection_name = file.collection;
    (groups[collection_name] = groups[collection_name] || []).push(file);
    return groups;
  }, {});
}

/**
 * Filters versions and gold entries by variant
 * @param {Object} file - File object containing versions and gold
 * @param {string|null} variant - Selected variant
 * @returns {Object} Object with filtered versions and gold arrays
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
 * @param {Object} file - File object containing gold entries
 * @param {string|null} variant - Selected variant
 * @returns {Object|null} Matching gold entry or null
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
 * @param {Array} fileData - The file data array
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
 * @param {Array} fileData - The file data array  
 * @param {string} pdfHash - Hash of the PDF file
 * @returns {Object|null} File object or null if not found
 */
export function findFileByPdfHash(fileData, pdfHash) {
  return fileData.find(file => file.pdf.hash === pdfHash) || null;
}

/**
 * Finds the corresponding PDF hash and collection for a given XML hash
 * @param {Array} fileData - The file data array
 * @param {string} xmlHash - Hash of the XML file (gold or version)
 * @returns {Object|null} Object with {pdfHash, collection} or null if not found
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