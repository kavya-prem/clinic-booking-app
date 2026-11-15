/**
 * The address of the Google data service (the Apps Script web app).
 * This is public on purpose: the page must know where to send requests.
 * It is not a Sheet ID or a PIN; the server checks the PIN and device for
 * every request.
 */
window.CLINIC_CONFIG = {
  API_URL: 'https://script.google.com/macros/s/AKfycbyzanUL5Br66hr-Uc81fJVUMlw0wax3xsUujWjxNxRf-T0rvJb9f6D7dhK7D4ogcM7i/exec'
};
