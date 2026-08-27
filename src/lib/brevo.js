/**
 * Brevo transactional email helper for CRM.
 * Enabled when BREVO_ENABLED=true and BREVO_API_KEY is set.
 */
const BREVO_API = 'https://api.brevo.com/v3';

export function brevoEnabled() {
  return (
    process.env.BREVO_ENABLED === 'true' &&
    Boolean((process.env.BREVO_API_KEY || '').trim())
  );
}

/**
 * @param {{ toEmail: string, toName?: string, subject: string, htmlContent?: string, textContent?: string }} opts
 */
export async function sendTransactionalEmail(opts) {
  if (!brevoEnabled()) {
    const err = new Error('Brevo is not enabled (set BREVO_ENABLED=true and BREVO_API_KEY)');
    err.code = 'BREVO_DISABLED';
    throw err;
  }

  const apiKey = process.env.BREVO_API_KEY.trim();
  const senderEmail = (process.env.BREVO_SENDER_EMAIL || '').trim();
  const senderName = (process.env.BREVO_SENDER_NAME || 'BMGenie').trim();
  if (!senderEmail) {
    throw new Error('BREVO_SENDER_EMAIL is required');
  }

  const body = {
    sender: { email: senderEmail, name: senderName },
    to: [{ email: opts.toEmail, name: opts.toName || undefined }],
    subject: opts.subject,
    htmlContent: opts.htmlContent || undefined,
    textContent: opts.textContent || opts.subject,
  };

  const res = await fetch(`${BREVO_API}/smtp/email`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `Brevo error ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}
