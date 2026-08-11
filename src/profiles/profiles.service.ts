import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FriendsService } from '../friends/friends.service';

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly friends: FriendsService,
  ) {}

  async getMyProfile(userId: string) {
    try {
      const user = await this.getUserWithProfile(userId);
      return { profile: this.serializeProfile(user) };
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new BadRequestException('Could not load your profile. Please try again.');
    }
  }

  async setAvatarUrl(userId: string, avatarUrl: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    try {
      await this.prisma.userProfile.upsert({
        where: { userId },
        create: { userId, avatarUrl },
        update: { avatarUrl },
      });
    } catch (error) {
      if (this.isProfileStorageUnavailable(error)) {
        throw new BadRequestException(
          'Profile storage is still being prepared. Please run the latest database migration and try again.',
        );
      }
      throw new BadRequestException('Could not save your avatar. Please try again.');
    }

    return { avatarUrl };
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

    // Preserve an existing avatar when the incoming payload doesn't carry one.
    const providedAvatarUrl = this.isRecord(body)
      ? this.cleanText((body as Record<string, unknown>).avatarUrl, 220)
      : null;
    if (!providedAvatarUrl) {
      delete (profileData as Record<string, unknown>).avatarUrl;
    }

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

  // ── Peer discovery / matching ───────────────────────────────────────────────
  // Rank other discoverable learners by shared study signals, so a student who
  // "struggles alone" can find people prepping for the same thing.
  async discoverPeers(userId: string) {
    const me = await this.prisma.userProfile.findUnique({ where: { userId } });
    const others = await this.prisma.userProfile.findMany({
      where: { isDiscoverable: true, userId: { not: userId } },
      include: { user: { select: { id: true, name: true } } },
    });

    const norm = (arr?: string[] | null) =>
      (arr || []).map((s) => s.trim().toLowerCase()).filter(Boolean);
    const overlap = (mine: Set<string>, theirs?: string[] | null) =>
      (theirs || []).filter((v) => mine.has(v.trim().toLowerCase()));

    const myGoals = new Set(norm(me?.goals));
    const myInterests = new Set(norm(me?.interests));
    const myExams = new Set(norm(me?.examTargets));
    const mySkills = new Set(norm(me?.skills));
    const myLangs = new Set(norm(me?.languages));
    const myTags = new Set([...myGoals, ...myInterests, ...myExams, ...mySkills]);
    const eq = (a?: string | null, b?: string | null) =>
      Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());

    const scored = others.map((p) => {
      const sharedGoals = overlap(myGoals, p.goals);
      const sharedInterests = overlap(myInterests, p.interests);
      const sharedExamTargets = overlap(myExams, p.examTargets);
      const sharedSkills = overlap(mySkills, p.skills);
      const sharedLanguages = overlap(myLangs, p.languages);
      const sameCollab =
        Boolean(me?.collaborationPreference) &&
        p.collaborationPreference === me?.collaborationPreference;
      const sameInstitution = eq(me?.institutionName, p.institutionName);
      const sameCity = eq(me?.city, p.city);
      const sameExperience =
        Boolean(me?.experienceLevel) && p.experienceLevel === me?.experienceLevel;

      const score =
        3 * sharedGoals.length +
        3 * sharedExamTargets.length +
        2 * sharedInterests.length +
        1 * sharedSkills.length +
        1 * sharedLanguages.length +
        (sameCollab ? 2 : 0) +
        (sameInstitution ? 3 : 0) +
        (sameCity ? 1 : 0) +
        (sameExperience ? 1 : 0);

      // Jaccard over the combined study-signal space for a friendly percent.
      const theirTags = new Set([
        ...norm(p.goals),
        ...norm(p.interests),
        ...norm(p.examTargets),
        ...norm(p.skills),
      ]);
      const inter = [...myTags].filter((t) => theirTags.has(t)).length;
      const union = new Set([...myTags, ...theirTags]).size;
      const matchPercent = union ? Math.round((inter / union) * 100) : 0;

      return {
        userId: p.userId,
        name: p.user?.name || p.username || 'PrepSy Learner',
        username: p.username,
        avatarUrl: p.avatarUrl,
        bio: p.bio,
        role: p.role,
        company: p.company,
        institutionName: p.institutionName,
        city: p.city,
        country: p.country,
        experienceLevel: p.experienceLevel,
        collaborationPreference: p.collaborationPreference,
        goals: p.goals,
        interests: p.interests,
        examTargets: p.examTargets,
        githubUrl: p.githubUrl,
        linkedinUrl: p.linkedinUrl,
        portfolioUrl: p.portfolioUrl,
        matchPercent,
        score,
        sharedGoals,
        sharedInterests,
        sharedExamTargets,
        sharedLanguages,
        sameInstitution,
      };
    });

    scored.sort((a, b) => b.score - a.score || b.matchPercent - a.matchPercent);
    const withOverlap = scored.filter((p) => p.score > 0);
    const top = (withOverlap.length ? withOverlap : scored).slice(0, 40);

    // Annotate each peer with the current user's friendship status.
    const statusMap = await this.friends.statusMap(
      userId,
      top.map((p) => p.userId),
    );
    const peers = top.map((p) => ({ ...p, friendStatus: statusMap[p.userId] || 'none' }));

    return { hasProfileSignals: myTags.size > 0, peers };
  }
}
