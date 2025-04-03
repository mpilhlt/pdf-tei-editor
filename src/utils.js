export function $(selector) {
    return document.querySelector(selector)
}

export function $$(selector) {
    return document.querySelectorAll(selector)
}

export function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[$]/g, '\\$&');
}