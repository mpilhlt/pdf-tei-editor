export function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[$]/g, '\\$&');
}

export function isDoi(doi) {
  // from https://www.crossref.org/blog/dois-and-matching-regular-expressions/
  const DOI_REGEX = /^10.\d{4,9}\/[-._;()\/:A-Z0-9]+$/i  
  return Boolean(doi.match(DOI_REGEX)) 
}

