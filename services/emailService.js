const path = require('path');
const nodemailer = require('nodemailer');

let transporter;

function getTransporter() {
    if (transporter) return transporter;

    transporter = nodemailer.createTransport({
        service: process.env.EMAIL_SERVICE || 'gmail',
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT) || 587,
        secure: false,
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASSWORD,
        },
    });

    return transporter;
}

function buildOtpHtml({ otp, firstName, title, intro }) {
    const greeting = firstName ? `Hi ${firstName},` : 'Hello,';
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#F4F6FA;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1A1A1A;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F6FA;padding:32px 16px;">
        <tr>
            <td align="center">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#FFFFFF;border-radius:16px;box-shadow:0 8px 24px rgba(15,27,51,0.06);overflow:hidden;">
                    <tr>
                        <td style="background:linear-gradient(135deg,#14274E 0%,#0C1A3A 55%,#07112A 100%);padding:32px 32px 24px;text-align:center;">
                            <img src="cid:vnp-logo" alt="VNP" width="140" style="display:inline-block;max-width:140px;height:auto;" />
                        </td>
                    </tr>
                    <tr>
                        <td style="padding:36px 40px 8px;">
                            <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#0F1B33;">${title}</h1>
                            <p style="margin:0;font-size:14px;line-height:1.6;color:#4B5563;">${greeting}<br/>${intro}</p>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding:24px 40px 8px;" align="center">
                            <div style="display:inline-block;padding:22px 32px;background:#0F1B33;border-radius:14px;color:#FFD200;font-size:38px;font-weight:700;letter-spacing:10px;font-family:'Courier New',monospace;">
                                ${otp}
                            </div>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding:24px 40px 40px;">
                            <p style="margin:0;font-size:13px;line-height:1.6;color:#6B7280;">If you did not request this code, you can safely ignore this email — someone may have entered your email address by mistake.</p>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding:20px 40px;background:#F4F6FA;text-align:center;font-size:11px;color:#9AA0AB;letter-spacing:1px;">
                            © ${new Date().getFullYear()} VNP — ALL RIGHTS RESERVED
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;
}

function logoAttachment() {
    return {
        filename: 'logo.svg',
        path: path.join(__dirname, '..', 'public', 'assets', 'logo.svg'),
        cid: 'vnp-logo',
        contentType: 'image/svg+xml',
    };
}

async function sendOtpEmail({ to, otp, firstName }) {
    const mailer = getTransporter();
    const from = process.env.SMTP_FROM || process.env.EMAIL_USER;

    await mailer.sendMail({
        from,
        to,
        subject: 'Your VNP verification code',
        text: `Your VNP verification code is ${otp}. It expires in 10 minutes.`,
        html: buildOtpHtml({
            otp,
            firstName,
            title: 'Your verification code',
            intro: 'Use the code below to finish signing in. This code expires in 10 minutes.',
        }),
        attachments: [logoAttachment()],
    });
}

function buildInviteHtml({ firstName, inviterName, inviteUrl, expiresInDays }) {
    const greeting = firstName ? `Hi ${firstName},` : 'Hello,';
    const fromLine = inviterName
        ? `${inviterName} has invited you to the VNP <> Airwallex console.`
        : `You've been invited to the VNP <> Airwallex console.`;
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>You've been invited to VNP</title>
</head>
<body style="margin:0;padding:0;background:#F4F6FA;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1A1A1A;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F6FA;padding:32px 16px;">
        <tr>
            <td align="center">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#FFFFFF;border-radius:16px;box-shadow:0 8px 24px rgba(15,27,51,0.06);overflow:hidden;">
                    <tr>
                        <td style="background:linear-gradient(135deg,#14274E 0%,#0C1A3A 55%,#07112A 100%);padding:32px 32px 24px;text-align:center;">
                            <img src="cid:vnp-logo" alt="VNP" width="140" style="display:inline-block;max-width:140px;height:auto;" />
                        </td>
                    </tr>
                    <tr>
                        <td style="padding:36px 40px 8px;">
                            <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#0F1B33;">You've been invited</h1>
                            <p style="margin:0;font-size:14px;line-height:1.6;color:#4B5563;">${greeting}<br/>${fromLine}</p>
                            <p style="margin:14px 0 0;font-size:14px;line-height:1.6;color:#4B5563;">Click the button below to accept and set your password. The link expires in <strong>${expiresInDays} days</strong>.</p>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding:24px 40px 8px;" align="center">
                            <a href="${inviteUrl}" style="display:inline-block;padding:14px 32px;background:#FFD200;color:#0F1B33;font-size:14px;font-weight:700;letter-spacing:0.2px;border-radius:10px;text-decoration:none;box-shadow:0 8px 20px rgba(255,210,0,0.25);">Accept invitation</a>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding:18px 40px 32px;">
                            <p style="margin:0;font-size:12px;line-height:1.6;color:#6B7280;">If the button doesn't work, copy and paste this link into your browser:<br/><a href="${inviteUrl}" style="color:#14274E;word-break:break-all;">${inviteUrl}</a></p>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding:24px 40px 40px;border-top:1px solid #EEF1F6;">
                            <p style="margin:0;font-size:13px;line-height:1.6;color:#6B7280;">If you weren't expecting this invite, you can safely ignore this email.</p>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding:20px 40px;background:#F4F6FA;text-align:center;font-size:11px;color:#9AA0AB;letter-spacing:1px;">
                            © ${new Date().getFullYear()} VNP — ALL RIGHTS RESERVED
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;
}

async function sendInviteEmail({ to, firstName, inviterName, inviteUrl, expiresInDays }) {
    const mailer = getTransporter();
    const from = process.env.SMTP_FROM || process.env.EMAIL_USER;

    await mailer.sendMail({
        from,
        to,
        subject: inviterName
            ? `${inviterName} invited you to VNP <> Airwallex`
            : `You've been invited to VNP <> Airwallex`,
        text: `You've been invited to the VNP <> Airwallex console. Accept your invitation here: ${inviteUrl} (expires in ${expiresInDays} days)`,
        html: buildInviteHtml({ firstName, inviterName, inviteUrl, expiresInDays }),
        attachments: [logoAttachment()],
    });
}

async function sendPasswordResetEmail({ to, otp, firstName }) {
    const mailer = getTransporter();
    const from = process.env.SMTP_FROM || process.env.EMAIL_USER;

    await mailer.sendMail({
        from,
        to,
        subject: 'Reset your VNP password',
        text: `Your VNP password reset code is ${otp}. It expires in 15 minutes. If you did not request this, you can ignore this email.`,
        html: buildOtpHtml({
            otp,
            firstName,
            title: 'Reset your password',
            intro: 'We received a request to reset your password. Use the code below to continue. This code expires in 15 minutes.',
        }),
        attachments: [logoAttachment()],
    });
}

module.exports = { sendOtpEmail, sendPasswordResetEmail, sendInviteEmail };