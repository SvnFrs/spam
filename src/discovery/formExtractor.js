/**
 * Form extraction module for finding and testing form submissions
 */
import * as cheerio from 'cheerio';

/**
 * Extract form fields from HTML
 * @param {string} html - HTML content
 * @returns {Object[]} Array of form objects
 */
export function extractFormFields(html) {
  try {
    const $ = cheerio.load(html);
    const forms = [];

    $("form").each((_, formElement) => {
      const form = {
        action: $(formElement).attr("action") || "",
        method: ($(formElement).attr("method") || "get").toLowerCase(),
        enctype: $(formElement).attr("enctype") || "application/x-www-form-urlencoded",
        id: $(formElement).attr("id") || "",
        class: $(formElement).attr("class") || "",
        fields: [],
        hasFileUpload: false,
        hasCsrf: false,
        csrfToken: null
      };

      // Check for file upload capability
      if (form.enctype === "multipart/form-data" || $(formElement).find('input[type="file"]').length > 0) {
        form.hasFileUpload = true;
      }

      // Check for CSRF tokens
      const csrfFields = $(formElement).find('input[name*="csrf"], input[name*="token"], input[name*="_token"], input[name*="nonce"]');
      if (csrfFields.length > 0) {
        form.hasCsrf = true;
        form.csrfToken = csrfFields.first().attr("value") || null;
      }

      $(formElement)
        .find("input, select, textarea, button")
        .each((_, input) => {
          const name = $(input).attr("name");
          if (name) {
            const field = {
              name: name,
              type: $(input).attr("type") || $(input).prop("tagName").toLowerCase(),
              value: $(input).attr("value") || "",
              required: $(input).attr("required") !== undefined,
              maxLength: $(input).attr("maxlength") || null,
              pattern: $(input).attr("pattern") || null,
              placeholder: $(input).attr("placeholder") || null,
              id: $(input).attr("id") || "",
              class: $(input).attr("class") || ""
            };

            // Handle select options
            if (field.type === 'select') {
              field.options = [];
              $(input).find('option').each((_, option) => {
                field.options.push({
                  value: $(option).attr('value') || $(option).text(),
                  text: $(option).text(),
                  selected: $(option).attr('selected') !== undefined
                });
              });
            }

            form.fields.push(field);
          }
        });

      forms.push(form);
    });

    return forms;
  } catch (error) {
    return [];
  }
}

/**
 * Generate form data for testing submissions
 * @param {Object} form - Form object with fields
 * @returns {Object} Generated form data
 */
export function generateFormData(form) {
  const data = {};
  const randomWords = ['test', 'example', 'sample', 'demo', 'user', 'admin', 'guest'];
  const randomWord = () => randomWords[Math.floor(Math.random() * randomWords.length)];

  form.fields.forEach((field) => {
    // Generate appropriate values based on field type and name
    let value = field.value;

    if (!value) {
      // Use hints from the field name
      const name = field.name.toLowerCase();

      if (name.includes('email') || name === 'mail') {
        const domains = ['example.com', 'test.org', 'mail.com', 'sample.net'];
        value = `user${Math.floor(Math.random() * 1000)}@${domains[Math.floor(Math.random() * domains.length)]}`;
      }
      else if (name.includes('pass') || name === 'pwd') {
        value = `Password${Math.floor(Math.random() * 1000)}!`;
      }
      else if (name.includes('user') || name === 'username' || name === 'login') {
        value = `user${Math.floor(Math.random() * 1000)}`;
      }
      else if (name.includes('name')) {
        const firstNames = ['John', 'Jane', 'Mike', 'Sarah', 'David', 'Lisa'];
        const lastNames = ['Smith', 'Jones', 'Brown', 'Wilson', 'Taylor'];
        if (name.includes('first')) {
          value = firstNames[Math.floor(Math.random() * firstNames.length)];
        } else if (name.includes('last')) {
          value = lastNames[Math.floor(Math.random() * lastNames.length)];
        } else {
          value = `${firstNames[Math.floor(Math.random() * firstNames.length)]} ${lastNames[Math.floor(Math.random() * lastNames.length)]}`;
        }
      }
      else if (name.includes('phone') || name.includes('mobile') || name.includes('tel')) {
        value = `+1${Math.floor(Math.random() * 1000000000).toString().padStart(9, '0')}`;
      }
      else if (name.includes('zip') || name.includes('postal')) {
        value = `${Math.floor(Math.random() * 100000).toString().padStart(5, '0')}`;
      }
      else if (name.includes('address')) {
        value = `${Math.floor(Math.random() * 1000)} Main St`;
      }
      else if (name.includes('city')) {
        const cities = ['New York', 'London', 'Paris', 'Tokyo', 'Sydney'];
        value = cities[Math.floor(Math.random() * cities.length)];
      }
      else if (name.includes('country')) {
        const countries = ['US', 'UK', 'FR', 'JP', 'AU'];
        value = countries[Math.floor(Math.random() * countries.length)];
      }
      else if (name.includes('comment') || name.includes('message')) {
        value = `This is a test message generated at ${new Date().toISOString()}`;
      }
      else if (name.includes('search') || name.includes('query')) {
        value = randomWord();
      }
      else if (name.includes('date')) {
        const date = new Date();
        value = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`;
      }
      else if (name.includes('time')) {
        const date = new Date();
        value = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
      }
      else if (name.includes('url') || name.includes('website')) {
        value = 'https://example.com';
      }
      else if (field.type === 'checkbox' || field.type === 'radio') {
        value = '1';
      }
      else if (field.type === 'number') {
        value = Math.floor(Math.random() * 100).toString();
      }
      else if (field.type === 'select') {
        // Use the first option or a selected option if available
        if (field.options && field.options.length > 0) {
          const selectedOption = field.options.find(opt => opt.selected);
          value = selectedOption ? selectedOption.value : field.options[0].value;
        } else {
          value = "1";
        }
      }
      else {
        // Generic value for other fields
        value = randomWord();
      }
    }

    // Respect field constraints
    if (field.maxLength && value.length > parseInt(field.maxLength)) {
      value = value.substring(0, parseInt(field.maxLength));
    }

    data[field.name] = value;
  });

  return data;
}

/**
 * Process HTTP response for form data extraction
 * @param {Object} response - Axios response object
 * @param {string} url - Original URL
 * @returns {Object[]|null} Extracted form data or null
 */
export function processResponseForForms(response, url) {
  // Process response for form analysis if it's HTML
  if (response.headers["content-type"] &&
    response.headers["content-type"].includes("text/html")) {
    try {
      const forms = extractFormFields(response.data);
      if (forms.length > 0) {
        // Generate form data for later use
        return forms.map(form => {
          return {
            action: form.action,
            method: form.method,
            data: generateFormData(form)
          };
        });
      }
    } catch (error) {
      // Ignore form parsing errors
    }
  }
  return null;
}