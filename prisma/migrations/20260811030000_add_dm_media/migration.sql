-- Media sharing in direct messages: image/file URL, type, and original name.
ALTER TABLE "DirectMessage" ADD COLUMN "mediaUrl" TEXT;
ALTER TABLE "DirectMessage" ADD COLUMN "mediaType" TEXT;
ALTER TABLE "DirectMessage" ADD COLUMN "fileName" TEXT;
