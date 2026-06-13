import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type ProfileInput = Record<string, unknown>;
type ProfileWriteData = Omit<
  Prisma.UserProfileUncheckedCreateInput,
  'id' | 'userId' | 'createdAt' | 'updatedAt'
>;

type ParsedProfileInput = {
  fullName: string | null;
  age: number | null;
  dailyStudyGoalMinutes: number;
  isDiscoverable: boolean;
  aiMonitorConsent: boolean;
} & Record<(typeof textFields)[number], string | null> &
  Record<(typeof arrayFields)[number], string[]>;

const arrayFields = [
  'goals',
  'interests',
  'skills',
  'languages',
  'examTargets',
  'lookingFor',
  'availability',
] as const;

const textFields = [
  'username',
  'phone',
  'avatarUrl',
  'bio',
  'gender',
  'city',
  'state',
  'country',
  'timezone',
  'institutionType',
  'institutionName',
  'degree',
  'branch',
  'semester',
  'expectedGraduation',
  'company',
  'role',
  'experienceLevel',
  'workMode',
  'collaborationPreference',
  'portfolioUrl',
  'linkedinUrl',
  'githubUrl',
] as const;

const requiredLabels: Record<string, string> = {
  fullName: 'Full name',
  age: 'Age',
  gender: 'Gender',
  goals: 'Goals',
};

const recommendationLabels: Record<string, string> = {
  city: 'City',
  institutionType: 'Institution type',
  institutionName: 'Institution name',
  interests: 'Interests',
  lookingFor: 'Collaboration preference',
  availability: 'Availability',
};

@Injectable()
export class ProfilesService {
  constructor(private readonly prisma: PrismaService) {}

  async getMyProfile(userId: string) {
    try {
      const user = await this.getUserWithProfile(userId);
      return { profile: this.serializeProfile(user) };
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new BadRequestException('Could not load your profile. Please try again.');
    }
  }

  async updateMyProfile(userId: string, body: unknown) {
    const input = this.parseInput(body);

    let existingUser: { id: string } | null;
    try {
      existingUser = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true },
      });
    } catch {
      throw new BadRequestException('Could not verify your account. Please try again.');
    }

    if (!existingUser) {
      throw new NotFoundException('User not found');
    }

    const validationProfile = {
      fullName: input.fullName,
      age: input.age,
      gender: input.gender,
      goals: input.goals,
    };
    const missingRequiredFields =
      this.getMissingRequiredFields(validationProfile);

    if (missingRequiredFields.length > 0) {
      throw new BadRequestException({
        message: 'Please complete the required profile fields.',
        missingRequiredFields,
      });
    }

    const profileData = this.toProfileUpdateInput(input);

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: userId },
          data: { name: input.fullName },
        });
        await tx.userProfile.upsert({
          where: { userId },
          create: { userId, ...profileData },
          update: profileData,
        });
      });
    } catch (error) {
      if (this.isUniqueProfileValue(error)) {
        throw new BadRequestException('This username is already taken.');
      }

      if (this.isProfileStorageUnavailable(error)) {
        throw new BadRequestException(
          'Profile storage is still being prepared. Please run the latest database migration and try again.',
        );
      }

      throw new BadRequestException('Could not save your profile. Please try again.');
    }

    try {
      const reloadedUser = await this.getUserWithProfile(userId);
      return {
        profile: this.serializeProfile(reloadedUser),
        message: 'Profile saved successfully.',
      };
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new BadRequestException('Profile saved but could not reload. Please refresh the page.');
    }
  }

  private async getUserWithProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    try {
      const profile = await this.prisma.userProfile.findUnique({
        where: { userId },
      });

      return {
        ...user,
        profile,
      };
    } catch (error) {
      if (this.isProfileStorageUnavailable(error)) {
        return {
          ...user,
          profile: null,
        };
      }

      throw error;
    }
  }

  private isProfileStorageUnavailable(error: unknown) {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      ['P2021', 'P2022'].includes(error.code)
    );
  }

  private isUniqueProfileValue(error: unknown) {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    );
  }

  private parseInput(body: unknown) {
    const input = this.isRecord(body) ? (body as ProfileInput) : {};

    const parsed = {
      fullName: this.cleanText(input.fullName, 90),
      age: this.cleanAge(input.age),
      dailyStudyGoalMinutes: this.cleanGoalMinutes(input.dailyStudyGoalMinutes),
      isDiscoverable:
        typeof input.isDiscoverable === 'boolean' ? input.isDiscoverable : true,
      aiMonitorConsent:
        typeof input.aiMonitorConsent === 'boolean' ? input.aiMonitorConsent : false,
      ...Object.fromEntries(
        textFields.map((field) => [field, this.cleanText(input[field], 220)]),
      ),
      ...Object.fromEntries(
        arrayFields.map((field) => [field, this.cleanArray(input[field])]),
      ),
    } as ParsedProfileInput;

    return parsed;
  }

  private toProfileUpdateInput(input: ParsedProfileInput) {
    const data: ProfileWriteData = {
      username: input.username,
      phone: input.phone,
      avatarUrl: input.avatarUrl,
      bio: input.bio,
      age: input.age,
      gender: input.gender,
      goals: input.goals,
      interests: input.interests,
      skills: input.skills,
      languages: input.languages,
      examTargets: input.examTargets,
      lookingFor: input.lookingFor,
      availability: input.availability,
      city: input.city,
      state: input.state,
      country: input.country,
      timezone: input.timezone,
      institutionType: input.institutionType,
      institutionName: input.institutionName,
      degree: input.degree,
      branch: input.branch,
      semester: input.semester,
      expectedGraduation: input.expectedGraduation,
      company: input.company,
      role: input.role,
      experienceLevel: input.experienceLevel,
      workMode: input.workMode,
      collaborationPreference: input.collaborationPreference,
      dailyStudyGoalMinutes: input.dailyStudyGoalMinutes,
      portfolioUrl: input.portfolioUrl,
      linkedinUrl: input.linkedinUrl,
      githubUrl: input.githubUrl,
      isDiscoverable: input.isDiscoverable,
      aiMonitorConsent: input.aiMonitorConsent,
    };

    return data;
  }

  private serializeProfile(user: {
    id: string;
    email: string;
    name: string | null;
    profile: null | {
      username: string | null;
      phone: string | null;
      avatarUrl: string | null;
      bio: string | null;
      age: number | null;
      gender: string | null;
      goals: string[];
      interests: string[];
      skills: string[];
      languages: string[];
      examTargets: string[];
      lookingFor: string[];
      availability: string[];
      city: string | null;
      state: string | null;
      country: string | null;
      timezone: string | null;
      institutionType: string | null;
      institutionName: string | null;
      degree: string | null;
      branch: string | null;
      semester: string | null;
      expectedGraduation: string | null;
      company: string | null;
      role: string | null;
      experienceLevel: string | null;
      workMode: string | null;
      collaborationPreference: string | null;
      dailyStudyGoalMinutes: number | null;
      portfolioUrl: string | null;
      linkedinUrl: string | null;
      githubUrl: string | null;
      isDiscoverable: boolean;
      aiMonitorConsent: boolean;
      updatedAt: Date;
    };
  }) {
    const profile = user.profile;
    const serialized = {
      userId: user.id,
      email: user.email,
      fullName: user.name || '',
      username: profile?.username || '',
      phone: profile?.phone || '',
      avatarUrl: profile?.avatarUrl || '',
      bio: profile?.bio || '',
      age: profile?.age || null,
      gender: profile?.gender || '',
      goals: profile?.goals || [],
      interests: profile?.interests || [],
      skills: profile?.skills || [],
      languages: profile?.languages || [],
      examTargets: profile?.examTargets || [],
      lookingFor: profile?.lookingFor || [],
      availability: profile?.availability || [],
      city: profile?.city || '',
      state: profile?.state || '',
      country: profile?.country || '',
      timezone: profile?.timezone || '',
      institutionType: profile?.institutionType || '',
      institutionName: profile?.institutionName || '',
      degree: profile?.degree || '',
      branch: profile?.branch || '',
      semester: profile?.semester || '',
      expectedGraduation: profile?.expectedGraduation || '',
      company: profile?.company || '',
      role: profile?.role || '',
      experienceLevel: profile?.experienceLevel || '',
      workMode: profile?.workMode || '',
      collaborationPreference: profile?.collaborationPreference || '',
      dailyStudyGoalMinutes: profile?.dailyStudyGoalMinutes ?? 0,
      portfolioUrl: profile?.portfolioUrl || '',
      linkedinUrl: profile?.linkedinUrl || '',
      githubUrl: profile?.githubUrl || '',
      isDiscoverable: profile?.isDiscoverable ?? true,
      aiMonitorConsent: profile?.aiMonitorConsent ?? false,
      updatedAt: profile?.updatedAt?.toISOString() || null,
    };

    const missingRequiredFields = this.getMissingRequiredFields(serialized);
    const missingRecommendationFields =
      this.getMissingRecommendationFields(serialized);

    return {
      ...serialized,
      completion: {
        requiredComplete: missingRequiredFields.length === 0,
        completionPercent: this.getCompletionPercent(serialized),
        missingRequiredFields,
        missingRecommendationFields,
      },
      matchingSignals: {
        goals: serialized.goals,
        interests: serialized.interests,
        city: serialized.city,
        institutionType: serialized.institutionType,
        institutionName: serialized.institutionName,
        skills: serialized.skills,
        languages: serialized.languages,
        lookingFor: serialized.lookingFor,
        availability: serialized.availability,
      },
    };
  }

  private getMissingRequiredFields(profile: {
    fullName?: string | null;
    age?: number | null;
    gender?: string | null;
    goals?: string[];
  }) {
    const missing: string[] = [];

    if (!profile.fullName?.trim()) missing.push(requiredLabels.fullName);
    if (!profile.age) missing.push(requiredLabels.age);
    if (!profile.gender?.trim()) missing.push(requiredLabels.gender);
    if (!profile.goals?.length) missing.push(requiredLabels.goals);

    return missing;
  }

  private getMissingRecommendationFields(profile: Record<string, unknown>) {
    return Object.entries(recommendationLabels)
      .filter(([field]) => {
        const value = profile[field];
        return Array.isArray(value)
          ? value.length === 0
          : !String(value || '').trim();
      })
      .map(([, label]) => label);
  }

  private getCompletionPercent(profile: Record<string, unknown>) {
    const trackedFields = [
      'fullName',
      'age',
      'gender',
      'goals',
      'interests',
      'city',
      'institutionType',
      'institutionName',
      'lookingFor',
      'availability',
      'skills',
      'languages',
    ];

    const completed = trackedFields.filter((field) => {
      const value = profile[field];
      return Array.isArray(value)
        ? value.length > 0
        : Boolean(String(value || '').trim());
    }).length;

    return Math.round((completed / trackedFields.length) * 100);
  }

  private cleanText(value: unknown, maxLength: number) {
    if (typeof value !== 'string') {
      return null;
    }

    const clean = value.trim().slice(0, maxLength);
    return clean || null;
  }

  private cleanArray(value: unknown) {
    const rawValues = Array.isArray(value)
      ? value
      : typeof value === 'string'
        ? value.split(',')
        : [];

    return Array.from(
      new Set(
        rawValues
          .map((item) => (typeof item === 'string' ? item.trim() : ''))
          .filter(Boolean)
          .slice(0, 16),
      ),
    );
  }

  private cleanGoalMinutes(value: unknown) {
    if (value === null || value === undefined || value === '') return 0;
    const n = Number(value);
    if (isNaN(n) || !Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(720, Math.round(n)));
  }

  private cleanAge(value: unknown) {
    if (value === null || value === undefined || value === '' || value === 'null') {
      return null;
    }
    const age = Number(value);
    if (isNaN(age) || !Number.isInteger(age)) {
      return null;
    }
    if (age < 13 || age > 100) {
      throw new BadRequestException('Age must be between 13 and 100.');
    }
    return age;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
  }
}
