import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { CommunityService } from './community.service';

@Controller('community')
export class CommunityController {
  constructor(private readonly communityService: CommunityService) {}

  private getUserId(req: any) {
    const userId = req?.user?.id || req?.user?.sub;
    if (!userId) {
      throw new UnauthorizedException('Invalid user token');
    }
    return userId;
  }

  @Get('posts')
  listPosts(
    @Query('search') search?: string,
    @Query('tag') tag?: string,
  ) {
    return this.communityService.listPosts(search, tag);
  }

  @Get('posts/:postId')
  getPostById(@Param('postId') postId: string) {
    return this.communityService.getPostById(postId);
  }

  @Post('posts')
  @UseGuards(JwtAuthGuard)
  createPost(
    @Req() req: any,
    @Body('title') title: string,
    @Body('content') content: string,
    @Body('tags') tags?: string[],
    @Body('applicationLink') applicationLink?: string,
  ) {
    return this.communityService.createPost(
      this.getUserId(req),
      title,
      content,
      tags,
      applicationLink,
    );
  }

  @Post('posts/:postId/replies')
  @UseGuards(JwtAuthGuard)
  createReply(
    @Req() req: any,
    @Param('postId') postId: string,
    @Body('content') content: string,
  ) {
    return this.communityService.createReply(this.getUserId(req), postId, content);
  }
}
