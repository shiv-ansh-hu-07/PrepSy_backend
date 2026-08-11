import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Put,
  Req,
  UnauthorizedException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../auth/jwt.guard';
import type { RequestWithUser } from '../auth/auth-user.interface';
import { ProfilesService } from './profiles.service';
import { S3Service } from '../s3/s3.service';

@Controller('profiles')
@UseGuards(JwtAuthGuard)
export class ProfilesController {
  constructor(
    private readonly profilesService: ProfilesService,
    private readonly s3Service: S3Service,
  ) {}

  private getUserId(req: RequestWithUser) {
    const userId = req?.user?.id || req?.user?.sub;
    if (!userId) {
      throw new UnauthorizedException('Invalid user token');
    }
    return userId;
  }

  @Get('me')
  getMyProfile(@Req() req: RequestWithUser) {
    return this.profilesService.getMyProfile(this.getUserId(req));
  }

  // Ranked list of other discoverable learners with shared study signals.
  @Get('discover')
  discoverPeers(@Req() req: RequestWithUser) {
    return this.profilesService.discoverPeers(this.getUserId(req));
  }

  @Put('me')
  updateMyProfile(@Req() req: RequestWithUser, @Body() body: unknown) {
    return this.profilesService.updateMyProfile(this.getUserId(req), body);
  }

  @Post('avatar')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 3 * 1024 * 1024 },
      fileFilter: (req, file, cb) => {
        if (/^image\/(jpeg|jpg|png|gif|webp)$/i.test(file.mimetype)) {
          cb(null, true);
        } else {
          cb(
            new BadRequestException(
              'Only image files are allowed (JPEG, PNG, GIF, WebP).',
            ),
            false,
          );
        }
      },
    }),
  )
  async uploadAvatar(
    @Req() req: RequestWithUser,
    @UploadedFile() file: Express.Multer.File,
  ) {
    const userId = this.getUserId(req);
    if (!file) {
      throw new BadRequestException('No image file provided.');
    }

    const avatarUrl = await this.s3Service.uploadAvatar(
      userId,
      file.buffer,
      file.mimetype,
      file.originalname,
    );

    // Persist the URL to the profile so it survives a page refresh.
    await this.profilesService.setAvatarUrl(userId, avatarUrl);

    return { avatarUrl };
  }
}
