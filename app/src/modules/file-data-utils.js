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
 * Document metadata from TEI header
 * @typedef {object} DocumentMetadata
 * @property {string} title - Document title
 * @property {object[]} authors - Array of author objects {given, family}
 * @property {string} [date] - Publication date
 * @property {string} [publisher] - Publisher name
 */

/**
 * Base file item - used for source files (PDF, primary XML)
 * @typedef {object} FileItem
 * @property {string} id - Stable ID for URLs and references
 * @property {string} filename - Filename
 * @property {string} file_type - 'pdf' or 'tei'
 * @property {string} label - Display label
 * @property {number} file_size - File size in bytes
 * @property {string} created_at - ISO timestamp
 * @property {string} updated_at - ISO timestamp
 */

/**
 * Artifact file item - extends FileItem with artifact-specific properties
 * @typedef {FileItem & {
 *   variant: string|null,
 *   version: number|null,
 *   is_gold_standard: boolean,
 *   is_locked: boolean,
 *   access_control: object|null
 * }} Artifact
 */

/**
 * Document item with source and artifacts
 * @typedef {object} DocumentItem
 * @property {string} doc_id - Document identifier
 * @property {string[]} collections - All collections for this document
 * @property {DocumentMetadata } doc_metadata - Document metadata from TEI header
 * @property {FileItem} source - Source file (PDF or primary XML)
 * @property {Artifact[]} artifacts - All artifact files (TEI, etc.)
 */

/**
 * File list response
 * @typedef {object} FileListResponse
 * @property {DocumentItem[]} files - Array of documents
 */

/**
 * Lookup item for index
 * @typedef {object} LookupItem
 * @property {"source" | "artifact"} type - Type of item
 * @property {FileItem | Artifact} item - The file or artifact item
 * @property {DocumentItem} file - Parent document
 * @property {string} label - Display label
 */

// Global lookup index for efficient ID-based queries
let idLookupIndex = new Map();

/**
 * Creates a lookup index that maps stable IDs to items
 * @param {DocumentItem[]} fileData - The file data array
 * @returns {Map<string, LookupItem>} Map of id to item with metadata
 */
export function createIdLookupIndex(fileData) {
  const index = new Map();

  fileData.forEach((file) => {
    // Index source file ID
    if (file.source && file.source.id) {
      index.set(file.source.id, {
        type: 'source',
        item: file.source,
        file: file,
        label: file.source.label
      });
    }

    // Index all artifacts
    if (file.artifacts) {
      file.artifacts.forEach((artifact) => {
        if (artifact.id) {
          index.set(artifact.id, {
            type: 'artifact',
            item: artifact,
            file: file,
            label: artifact.label
          });
        }
      });
    }
  });

  // Store globally for use by other functions
  idLookupIndex = index;
  return index;
}

/**
 * Legacy function for backward compatibility - calls createIdLookupIndex
 * @deprecated Use createIdLookupIndex instead
 * @param {DocumentItem[]} fileData - The file data array
 * @returns {Map<string, LookupItem>} Map of id to item with metadata
 */
export function createHashLookupIndex(fileData) {
  return createIdLookupIndex(fileData);
}

/**
 * Gets file data entry from idLookupIndex based on stable ID
 * @param {string} id - Stable ID of any file (source or artifact)
 * @returns {LookupItem|null} Entry object with {type, item, file, label} or null if not found
 */
export function getFileDataById(id) {
  if (!id) return null;

  if (!idLookupIndex || idLookupIndex.size === 0) {
    throw new Error('ID lookup index not initialized. Call createIdLookupIndex() first.');
  }

  return idLookupIndex.get(id) || null;
}

/**
 * Legacy function for backward compatibility - calls getFileDataById
 * @deprecated Use getFileDataById instead
 * @param {string} hash - Hash/ID of any file
 * @returns {LookupItem|null} Entry object or null if not found
 */
export function getFileDataByHash(hash) {
  return getFileDataById(hash);
}

/**
 * Gets document title/label from fileData based on stable ID
 * @param {string} id - Stable ID of any file (source or artifact)
 * @returns {string} Document title/label or empty string if not found
 */
export function getDocumentTitle(id) {
  const entry = getFileDataById(id);
  return entry?.label || '';
}

/**
 * Extracts all unique variants from file data
 * @param {DocumentItem[]} fileData - The file data array
 * @returns {Set<string>} Set of unique variant IDs
 */
export function extractVariants(fileData) {
  const variants = new Set();

  fileData.forEach(file => {
    // Add variant from all artifacts
    if (file.artifacts) {
      file.artifacts.forEach(artifact => {
        if (artifact.variant) {
          variants.add(artifact.variant);
        }
      });
    }
  });

  return variants;
}

/**
 * Filters file data by variant selection
 * @param {DocumentItem[]} fileData - The file data array
 * @param {string|null} variant - Selected variant ("", "none", or variant ID)
 * @returns {DocumentItem[]} Filtered file data
 */
export function filterFileDataByVariant(fileData, variant) {
  if (variant === "none") {
    // Show only files with artifacts that have no variant
    return fileData.filter(file => {
      return file.artifacts && file.artifacts.some(a => !a.variant);
    });
  } else if (variant && variant !== "") {
    // Show only files with artifacts matching the selected variant
    return fileData.filter(file => {
      return file.artifacts && file.artifacts.some(a => a.variant === variant);
    });
  }
  // If variant is "" (All), show all files
  return fileData;
}

/**
 * Filters file data by label text search
 * @param {DocumentItem[]} fileData - The file data array
 * @param {string} searchText - Text to search for in labels
 * @returns {DocumentItem[]} Filtered file data
 */
export function filterFileDataByLabel(fileData, searchText) {
  if (!searchText || searchText.trim() === '') {
    return fileData;
  }

  const search = searchText.toLowerCase();
  return fileData.filter(file =>
    file.source.label && file.source.label.toLowerCase().includes(search)
  );
}

/**
 * Groups file data by collection
 * @param {DocumentItem[]} fileData - The file data array
 * @returns {Record<string, DocumentItem[]>} Grouped files by collection name
 */
export function groupFilesByCollection(fileData) {
  /** @type Record<string, DocumentItem[]> */
  const groups = {}
  return fileData.reduce((groups, file) => {
    // Add document to all its collections (documents can appear in multiple collection groups)
    if (file.collections && file.collections.length > 0) {
      for (const collection_name of file.collections) {
        groups[collection_name] ||= []
        groups[collection_name].push(file);
      }
    } else {
      // No collections - add to unfiled
      groups["__unfiled"] ||= []
      groups["__unfiled"].push(file);
    }
    return groups;
  }, groups);
}

/**
 * Filters artifacts by variant - simplified version for flat artifacts array
 * @param {DocumentItem} file - File object containing artifacts
 * @param {string|null} variant - Selected variant
 * @returns {{versions: Artifact[], gold: Artifact[]}} Object with filtered versions and gold arrays
 */
export function filterFileContentByVariant(file, variant) {
  let artifacts = file.artifacts || [];

  if (variant === "none") {
    // Show only artifacts without variant
    artifacts = file.artifacts ? file.artifacts.filter(a => !a.variant) : [];
  } else if (variant && variant !== "") {
    // Show only artifacts with the selected variant
    artifacts = file.artifacts ? file.artifacts.filter(a => a.variant === variant) : [];
  }
  // If variant is "" (All), show all artifacts (already assigned above)

  // Separate into versions and gold for backward compatibility
  const versions = artifacts.filter(a => !a.is_gold_standard);
  const gold = artifacts.filter(a => a.is_gold_standard);

  return { versions, gold };
}

/**
 * Finds a matching gold file based on variant selection
 * @param {DocumentItem} file - File object containing artifacts
 * @param {string|null} variant - Selected variant
 * @returns {Artifact|null} Matching gold artifact or null
 */
export function findMatchingGold(file, variant) {
  if (!file.artifacts) return null;

  // Filter to only gold standards
  const goldArtifacts = file.artifacts.filter(a => a.is_gold_standard);

  if (variant === "none") {
    // Find gold without variant
    return goldArtifacts.find(gold => !gold.variant) || null;
  } else if (variant && variant !== "") {
    // Find gold with matching variant
    return goldArtifacts.find(gold => gold.variant === variant) || null;
  } else {
    // No variant filter - use first gold file
    return goldArtifacts[0] || null;
  }
}

/**
 * Finds the collection for a given file ID by searching through file data
 * @param {DocumentItem[]} fileData - The file data array
 * @param {string} id - Stable ID of the file to find
 * @returns {string|null} Collection name or null if not found
 */
export function findCollectionById(id) {
  const entry = getFileDataById(id);
  if (entry && entry.file.collections && entry.file.collections[0]) {
    return entry.file.collections[0];
  }
  return null;
}

/**
 * Legacy function for backward compatibility - calls findCollectionById
 * @deprecated Use findCollectionById instead
 * @param {DocumentItem[]} fileData - The file data array
 * @param {string} hash - ID of the file to find
 * @returns {string|null} Collection name or null if not found
 */
export function findCollectionByHash(fileData, hash) {
  return findCollectionById(hash);
}

/**
 * Finds a file object by source ID
 * @param {DocumentItem[]} fileData - The file data array
 * @param {string} sourceId - Stable ID of the source file
 * @returns {DocumentItem|null} File object or null if not found
 */
export function findFileBySourceId(fileData, sourceId) {
  return fileData.find(file => file.source.id === sourceId) || null;
}

/**
 * Legacy function for backward compatibility - calls findFileBySourceId
 * @deprecated Use findFileBySourceId instead
 * @param {DocumentItem[]} fileData - The file data array
 * @param {string} pdfHash - ID of the source file
 * @returns {DocumentItem|null} File object or null if not found
 */
export function findFileByPdfHash(fileData, pdfHash) {
  return findFileBySourceId(fileData, pdfHash);
}

/**
 * Gets the display name for a collection
 * @param {string} collectionId - Collection ID
 * @param {Array<{id: string, name: string, description: string}>} collections - Collections array from state
 * @returns {string} Display name for the collection
 */
export function getCollectionName(collectionId, collections) {
  if (collectionId === "__unfiled") {
    return "Unfiled";
  }

  if (!collections || collections.length === 0) {
    // Fallback to converting underscores to spaces if collections not loaded
    return collectionId.replaceAll("_", " ").trim();
  }

  const collection = collections.find(c => c.id === collectionId);
  return collection ? collection.name : collectionId.replaceAll("_", " ").trim();
}

/**
 * Finds the corresponding source ID and collection for a given artifact ID
 * @param {DocumentItem[]} fileData - The file data array
 * @param {string} artifactId - Stable ID of the artifact file
 * @returns {{sourceId: string, collection: string}|null} Object with {sourceId, collection} or null if not found
 */
export function findCorrespondingSource(fileData, artifactId) {
  const entry = getFileDataById(artifactId);
  if (entry && entry.type === 'artifact' && entry.file) {
    return {
      sourceId: entry.file.source.id,
      collection: entry.file.collections && entry.file.collections[0]
    };
  }
  return null;
}

/**
 * Legacy function for backward compatibility - calls findCorrespondingSource
 * @deprecated Use findCorrespondingSource instead
 * @param {DocumentItem[]} fileData - The file data array
 * @param {string} xmlHash - ID of the artifact file
 * @returns {{pdfHash: string, collection: string}|null} Object with {pdfHash, collection} or null if not found
 */
export function findCorrespondingPdf(fileData, xmlHash) {
  const result = findCorrespondingSource(fileData, xmlHash);
  if (result) {
    return {
      pdfHash: result.sourceId,
      collection: result.collection
    };
  }
  return null;
}