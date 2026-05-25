/*
  Warnings:

  - Added the required column `expiresAt` to the `Meeting` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Meeting" ADD COLUMN "expiresAt" TIMESTAMP(3);

-- Update existing meetings: set expiresAt to NOW + 24 hours
UPDATE "Meeting" SET "expiresAt" = NOW() + INTERVAL '24 hours' WHERE "expiresAt" IS NULL;

-- Make expiresAt NOT NULL
ALTER TABLE "Meeting" ALTER COLUMN "expiresAt" SET NOT NULL;
