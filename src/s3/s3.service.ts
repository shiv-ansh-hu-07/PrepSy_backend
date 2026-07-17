import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { extname } from 'path';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class S3Service {
  private readonly logger = new Logger(S3Service.name);
  private readonly client: S3Client;
  private readonly bucket = process.env.S3_BUCKET_NAME;
  private readonly cloudfrontDomain = process.env.CLOUDFRONT_DOMAIN;

  constructor() {
    // Credentials are resolved from the ECS/EC2 task IAM role via the default
    // AWS provider chain — do not pass access keys here.
    this.client = new S3Client({ region: process.env.AWS_REGION });
  }

  /**
   * Uploads an avatar image buffer to S3 and returns a public URL served via
   * CloudFront (falling back to the direct S3 URL if no CDN is configured).
   */
  async uploadAvatar(
    userId: string,
    buffer: Buffer,
    mimetype: string,
    originalName: string,
  ): Promise<string> {
    if (!this.bucket) {
      this.logger.error('S3_BUCKET_NAME is not configured');
      throw new InternalServerErrorException('File storage is not configured');
    }

    const ext = extname(originalName).toLowerCase() || '.jpg';
    const key = `avatars/${userId}/${uuidv4()}${ext}`;

    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: buffer,
          ContentType: mimetype,
          CacheControl: 'public, max-age=31536000, immutable',
        }),
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown S3 upload error';
      this.logger.error(`Avatar upload failed for ${userId}: ${message}`);
      throw new BadRequestException(
        'Failed to upload image. Please try again.',
      );
    }

    if (this.cloudfrontDomain) {
      return `https://${this.cloudfrontDomain}/${key}`;
    }

    return `https://${this.bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
  }
}
