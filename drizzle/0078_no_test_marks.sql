-- Resend's test addresses (bounced@resend.dev, complained@resend.dev, delivered@resend.dev) exist to
-- make a bounce or a complaint on purpose. One test on 23 September 2026 proved the webhook end to end
-- and left a mark that turned the service board's bounce row yellow: one bounce of 49 mails is 2%.
-- recordMark now ignores that domain; this removes the mark it left. A no-op anywhere else.
delete from email_marks where address like '%@resend.dev';
