import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CommunityService {
  constructor(private readonly prisma: PrismaService) {}

  private readonly postSummarySelect = {
    id: true,
    title: true,
    content: true,
    applicationLink: true,
    tags: true,
    createdAt: true,
    updatedAt: true,
    author: {
      select: {
        id: true,
        name: true,
        email: true,
      },
    },
    _count: {
      select: {
        replies: true,
      },
    },
  } as const;

  private normalizeTags(tags?: string[]) {
    return Array.from(
      new Set(
        (tags || [])
          .map((tag) => tag?.trim().toLowerCase())
          .filter((tag): tag is string => Boolean(tag))
          .slice(0, 5),
      ),
    );
  }

  private normalizeAuthorName(author: { name: string | null; email: string }) {
    return author.name?.trim() || author.email.split('@')[0] || 'Anonymous';
  }

  private normalizeApplicationLink(applicationLink?: string) {
    const cleanLink = applicationLink?.trim();

    if (!cleanLink) {
      return null;
    }

    try {
      const url = new URL(cleanLink);

      if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('Unsupported protocol');
      }

      return url.toString();
    } catch {
      throw new BadRequestException(
        'Application link must be a valid http or https URL',
      );
    }
  }

  private mapPostSummary(post: {
    id: string;
    title: string;
    content: string;
    applicationLink: string | null;
    tags: string[];
    createdAt: Date;
    updatedAt: Date;
    author: {
      id: string;
      name: string | null;
      email: string;
    };
    _count: {
      replies: number;
    };
  }) {
    return {
      id: post.id,
      title: post.title,
      content: post.content,
      applicationLink: post.applicationLink,
      tags: post.tags,
      createdAt: post.createdAt,
      updatedAt: post.updatedAt,
      replyCount: post._count.replies,
      author: {
        id: post.author.id,
        name: this.normalizeAuthorName(post.author),
      },
    };
  }

  async listPosts(search?: string, tag?: string) {
    const query = search?.trim();
    const normalizedTag = tag?.trim().toLowerCase();

    const posts = await this.prisma.communityPost.findMany({
      where: {
        AND: [
          normalizedTag
            ? {
                tags: {
                  has: normalizedTag,
                },
              }
            : {},
          query
            ? {
                OR: [
                  { title: { contains: query, mode: 'insensitive' } },
                  { content: { contains: query, mode: 'insensitive' } },
                ],
              }
            : {},
        ],
      },
      select: this.postSummarySelect,
      orderBy: {
        createdAt: 'desc',
      },
      take: 50,
    });

    return {
      posts: posts.map((post) => this.mapPostSummary(post)),
    };
  }

  async listMyPosts(userId: string) {
    const posts = await this.prisma.communityPost.findMany({
      where: {
        authorId: userId,
      },
      select: this.postSummarySelect,
      orderBy: {
        createdAt: 'desc',
      },
      take: 50,
    });

    return {
      posts: posts.map((post) => this.mapPostSummary(post)),
    };
  }

  async getPostById(postId: string) {
    const post = await this.prisma.communityPost.findUnique({
      where: { id: postId },
      include: {
        author: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        replies: {
          include: {
            author: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
          },
          orderBy: {
            createdAt: 'asc',
          },
        },
        _count: {
          select: {
            replies: true,
          },
        },
      },
    });

    if (!post) {
      throw new NotFoundException('Post not found');
    }

    return {
      post: {
        ...this.mapPostSummary(post),
        replies: post.replies.map((reply) => ({
          id: reply.id,
          content: reply.content,
          createdAt: reply.createdAt,
          updatedAt: reply.updatedAt,
          author: {
            id: reply.author.id,
            name: this.normalizeAuthorName(reply.author),
          },
        })),
      },
    };
  }

  async createPost(
    userId: string,
    title: string,
    content: string,
    tags?: string[],
    applicationLink?: string,
  ) {
    const cleanTitle = title?.trim();
    const cleanContent = content?.trim();

    if (!cleanTitle) {
      throw new BadRequestException('Post title is required');
    }

    if (!cleanContent) {
      throw new BadRequestException('Post content is required');
    }

    if (cleanTitle.length > 140) {
      throw new BadRequestException('Post title must be 140 characters or fewer');
    }

    if (cleanContent.length > 5000) {
      throw new BadRequestException('Post content must be 5000 characters or fewer');
    }

    const createdPost = await this.prisma.communityPost.create({
      data: {
        authorId: userId,
        title: cleanTitle,
        content: cleanContent,
        applicationLink: this.normalizeApplicationLink(applicationLink),
        tags: this.normalizeTags(tags),
      },
      select: this.postSummarySelect,
    });

    return {
      post: this.mapPostSummary(createdPost),
    };
  }

  async createReply(userId: string, postId: string, content: string) {
    const cleanContent = content?.trim();

    if (!cleanContent) {
      throw new BadRequestException('Reply content is required');
    }

    if (cleanContent.length > 3000) {
      throw new BadRequestException('Reply content must be 3000 characters or fewer');
    }

    const postExists = await this.prisma.communityPost.findUnique({
      where: { id: postId },
      select: { id: true },
    });

    if (!postExists) {
      throw new NotFoundException('Post not found');
    }

    const reply = await this.prisma.communityReply.create({
      data: {
        authorId: userId,
        postId,
        content: cleanContent,
      },
      include: {
        author: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    return {
      reply: {
        id: reply.id,
        content: reply.content,
        createdAt: reply.createdAt,
        updatedAt: reply.updatedAt,
        author: {
          id: reply.author.id,
          name: this.normalizeAuthorName(reply.author),
        },
      },
    };
  }

  async updatePost(
    userId: string,
    postId: string,
    title: string,
    content: string,
    tags?: string[],
    applicationLink?: string,
  ) {
    const cleanTitle = title?.trim();
    const cleanContent = content?.trim();

    if (!cleanTitle) {
      throw new BadRequestException('Post title is required');
    }

    if (!cleanContent) {
      throw new BadRequestException('Post content is required');
    }

    if (cleanTitle.length > 140) {
      throw new BadRequestException('Post title must be 140 characters or fewer');
    }

    if (cleanContent.length > 5000) {
      throw new BadRequestException('Post content must be 5000 characters or fewer');
    }

    const existingPost = await this.prisma.communityPost.findUnique({
      where: { id: postId },
      select: { id: true, authorId: true },
    });

    if (!existingPost) {
      throw new NotFoundException('Post not found');
    }

    if (existingPost.authorId !== userId) {
      throw new ForbiddenException('You can only edit your own posts');
    }

    const updatedPost = await this.prisma.communityPost.update({
      where: { id: postId },
      data: {
        title: cleanTitle,
        content: cleanContent,
        applicationLink: this.normalizeApplicationLink(applicationLink),
        tags: this.normalizeTags(tags),
      },
      select: this.postSummarySelect,
    });

    return {
      post: this.mapPostSummary(updatedPost),
    };
  }

  async deletePost(userId: string, postId: string) {
    const existingPost = await this.prisma.communityPost.findUnique({
      where: { id: postId },
      select: { id: true, authorId: true },
    });

    if (!existingPost) {
      throw new NotFoundException('Post not found');
    }

    if (existingPost.authorId !== userId) {
      throw new ForbiddenException('You can only delete your own posts');
    }

    await this.prisma.communityPost.delete({
      where: { id: postId },
    });

    return {
      success: true,
    };
  }
}
