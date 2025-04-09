 export class CookieStorage {
    /**
     * Constructor for CookieStorage.
     * @param {object} [config={}] - Configuration for cookies.
     * @param {string} [config.path='/'] - The default path for cookies.
     * @param {boolean} [config.secure=true] - Whether cookies should be secure.
     * @param {string} [config.sameSite='Strict'] - The SameSite attribute (e.g., 'Strict', 'Lax', or 'None').
     * @param {number} [config.maxAge=604800] - The default max-age for cookies (in seconds, default is 7 days).
     */
    constructor(config = {}) {
        this.config = {
            path: config.path || '/',
            secure: config.secure !== undefined ? config.secure : true,
            sameSite: config.sameSite || 'Strict',
            maxAge: config.maxAge !== undefined ? config.maxAge : 7 * 24 * 60 * 60 // Default: 7 days
        };
    }

    /**
     * Retrieves a value from cookies by key. If it can be converted from a
     * JSON string, return the converted value.
     * @param {string} key - The key of the cookie to retrieve.
     * @returns {string|Object|null} The cookie value, or null if not found.
     */
    get(key) {
        const cookie = document.cookie
            .split('; ')
            .find(row => row.startsWith(`${key}=`));
        let value = cookie ? decodeURIComponent(cookie.split('=')[1]) : null;
        if (value && typeof value === "string") {
            try {
                value = JSON.parse(value);
            } catch (e) {
                // just keep the old value
            }
        }
        return value;
    }

    /**
     * Returns true if the key exists in the cookies or false if not
     * @param {string} key The key of the hash parameter to retrieve.
     * @returns {boolean}
     */
    static has(key) {
        return this.get(key) !== null;
    }      

    /**
     * Sets a cookie with a specified key and value. If it is not a string,
     * JSON-encode it before storing it. 
     * @param {string} key - The key of the cookie.
     * @param {string|Object} value - The value of the cookie.
     * @param {object} [options={}] - Optional overrides for the configuration.
     */
    set(key, value, options = {}) {
        if (typeof value != "string") {
            value = JSON.stringify(value);
        }
        const { path, secure, sameSite, maxAge } = { ...this.config, ...options };
        let cookie = `${key}=${encodeURIComponent(value)}; path=${path}; samesite=${sameSite}`;
        if (secure) cookie += '; secure';
        if (maxAge !== undefined) cookie += `; max-age=${maxAge}`;
        document.cookie = cookie;
    }

    /**
     * Removes a cookie by key.
     * @param {string} key - The key of the cookie to remove.
     * @param {object} [options={}] - Optional overrides for the configuration.
     */
    remove(key, options = {}) {
        const { path, sameSite } = { ...this.config, ...options };
        const cookie = `${key}=; path=${path}; samesite=${sameSite}; max-age=0`;
        document.cookie = cookie;
    }
}


export class UrlHash {

    /**
     * Sets or updates a hash parameter in the URL without reloading the page and ensures browser history is updated.
     * @param {string} key - The key of the hash parameter to set.
     * @param {string} value - The value of the hash parameter to set.
     */
    static set(key, value) {
        const hash = new URLSearchParams(window.location.hash.slice(1));
        hash.set(key, value);

        // Use history.pushState to store the previous state in the browser's history
        history.pushState(null, '', '#' + hash.toString());
        window.dispatchEvent(new HashChangeEvent('hashchange'));
    }

    /**
     * Retrieves the value of a hash parameter from the URL.
     * @param {string} key - The key of the hash parameter to retrieve.
     * @returns {string|null} The value of the hash parameter, or null if not found.
     */
    static get(key) {
        const hash = new URLSearchParams(window.location.hash.slice(1));
        return hash.get(key);
    }

    /**
     * Returns true if the key exists in the URL hash or false if not
     * @param {string} key The key of the hash parameter to retrieve.
     * @returns  {boolean}
     */
    static has(key) {
        return UrlHash.get(key) !== null;
    }    

    /**
     * Removes a hash parameter from the URL without reloading the page.
     * @param {string} key - The key of the hash parameter to remove.
     */
    static remove(key) {
        if (!UrlHash.has(key)) return; // Do nothing if the key does not exist
        const hash = new URLSearchParams(window.location.hash.slice(1));
        hash.delete(key); // Remove the specified key
        const updatedHash = hash.toString();
        window.location.hash = updatedHash ? updatedHash : ''; // Update the hash or clear it
        window.dispatchEvent(new HashChangeEvent('hashchange'));
    }
}