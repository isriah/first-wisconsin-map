// Settings for the page. Fill these in after the Cloudflare Worker is deployed (see README.md).
window.MAP_CONFIG = {
  // Full URL of the Worker's contact endpoint, e.g. "https://first-wisconsin-map-contact.example.workers.dev/contact".
  contactEndpoint: 'https://first-wisconsin-map-contact.frc-attendance.workers.dev/contact',
  // Cloudflare Turnstile site key (public). Leave empty to run without the bot check.
  turnstileSiteKey: '',
};
