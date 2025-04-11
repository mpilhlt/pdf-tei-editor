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

// Non-blocking alert()
export async function showMessage(message, title="Information") {
    const dialog = document.getElementById('dialog-message');
    dialog.showModal();
    dialog.querySelector('.dialog-header').textContent = title;
    dialog.querySelector('.dialog-content').textContent = message;
    const closeButton = dialog.querySelector('.dialog-close');
    await new Promise(resolve => closeButton.addEventListener("click", resolve, {once: true}))
    dialog.close()
}

/**
 * Uploads a file selected by the user to a specified URL using `fetch()`.
 *
 * @author Gemini 2.0
 * @param {string} uploadUrl - The URL to which the file will be uploaded.
 * @param {object} [options={}] - Optional configuration options.
 * @param {string} [options.method='POST'] - The HTTP method to use for the upload.
 * @param {string} [options.fieldName='file'] - The name of the form field for the file.
 * @param {object} [options.headers={}] - Additional headers to include in the request.
 * @param {function} [options.onProgress] - A callback function to handle upload progress events.
 *        The function receives a progress event object as an argument.
 * @returns {Promise<Response>} - A Promise that resolves with the `Response` object
 *                             from the `fetch()` call or rejects with an error.
 * @example
 * // Async/Await example (requires an async function context):
 * async function myUploadFunction() {
 *   try {
 *     const response = await uploadFile('https://example.com/upload', {
 *       fieldName: 'my_file',
 *       headers: {
 *         'X-Custom-Header': 'value'
 *       },
 *       onProgress: (event) => {
 *         if (event.lengthComputable) {
 *           const percentComplete = (event.loaded / event.total) * 100;
 *           console.log(`Uploaded: ${percentComplete.toFixed(2)}%`);
 *         } else {
 *           console.log("Total size is unknown");
 *         }
 *       } 
 *     });
 *
 *     if (response.ok) {
 *       const data = await response.json();
 *       console.log('Upload successful:', data);
 *     } else {
 *       throw new Error(`Upload failed: ${response.status} ${response.statusText}`);
 *     }
 *   } catch (error) {
 *     console.error('Error uploading file:', error);
 *   }
 * }
 */
export async function uploadFile(uploadUrl, options = {}) {
    return new Promise((resolve, reject) => {
      const {
        method = 'POST',
        fieldName = 'file',
        headers = {},
        onProgress,
      } = options;
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.pdf, .xml';
      input.addEventListener('change', async () => {
        const file = input.files[0];
        if (!file) {
          reject(new Error('No file selected.'));
          return;
        }
        const formData = new FormData();
        formData.append(fieldName, file);
        const fetchOptions = {
          method: method,
          body: formData,
          headers: headers
        };
        try {
          const response = await fetch(uploadUrl, fetchOptions);
          if (!response.ok) {
            reject(new Error(`HTTP error! Status: ${response.status}`));
            return;
          }
          let result = await response.json()
          if (result.error) {
            reject(result.error)
          }
          resolve(result); 
        } catch (error) {
          reject(error);
        }
      });
  
      // Programmatically trigger the file chooser dialog.  Crucially, this must be initiated from a user action,
      // such as a button click, to work correctly in most browsers. Directly calling input.click() on page load will generally be blocked.
      input.click();
    });
  }