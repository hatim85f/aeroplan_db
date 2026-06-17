/**
 * Transactional email via the Brevo (Sendinblue) API using saved templates.
 *
 * Environment variables:
 *   BREVO_KEY                       - Brevo API key (v3)                       [required]
 *   EMAIL_FROM                      - verified sender email (default info@aero-plan.me)
 *   EMAIL_FROM_NAME                 - sender display name (default "AeroPlan")
 *   BREVO_VERIFICATION_TEMPLATE_ID  - account confirmation template (default 5)
 *   BREVO_RESET_TEMPLATE_ID         - password reset template (default 6)
 *
 * Template variables expected by the Brevo templates:
 *   #5 confirmation : {{ params.fullName }}, {{ params.confirmation_code }}
 *   #6 reset        : {{ params.fullName }}, {{ params.reset_code }}
 */

const BREVO_API_URL = "https://api.brevo.com/v3/smtp/email";

const getSender = () => ({
  email: process.env.EMAIL_FROM || "info@aero-plan.me",
  name: process.env.EMAIL_FROM_NAME || "AeroPlan",
});

const getVerificationTemplateId = () =>
  Number(process.env.BREVO_VERIFICATION_TEMPLATE_ID || 5);

const getResetTemplateId = () =>
  Number(process.env.BREVO_RESET_TEMPLATE_ID || 6);

const sendTemplateEmail = async ({ to, templateId, params }) => {
  const apiKey = process.env.BREVO_KEY;

  if (!apiKey) {
    throw new Error("Email is not configured. Set BREVO_KEY.");
  }

  if (typeof fetch !== "function") {
    throw new Error("global fetch is unavailable (Node 18+ required).");
  }

  const response = await fetch(BREVO_API_URL, {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      sender: getSender(),
      to: [{ email: to }],
      templateId,
      params,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Brevo email failed (${response.status}): ${detail}`);
  }

  return response.json().catch(() => ({}));
};

const sendVerificationCodeEmail = async ({ to, code, name }) =>
  sendTemplateEmail({
    to,
    templateId: getVerificationTemplateId(),
    params: {
      fullName: name || "",
      confirmation_code: code,
    },
  });

const sendPasswordResetEmail = async ({ to, code, name }) =>
  sendTemplateEmail({
    to,
    templateId: getResetTemplateId(),
    params: {
      fullName: name || "",
      reset_code: code,
    },
  });

module.exports = {
  sendTemplateEmail,
  sendVerificationCodeEmail,
  sendPasswordResetEmail,
};
