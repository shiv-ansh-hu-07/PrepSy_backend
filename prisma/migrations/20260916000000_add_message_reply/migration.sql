-- WhatsApp-style reply context on chat messages.
ALTER TABLE "Message" ADD COLUMN "replyToText" TEXT;
ALTER TABLE "Message" ADD COLUMN "replyToSender" TEXT;
