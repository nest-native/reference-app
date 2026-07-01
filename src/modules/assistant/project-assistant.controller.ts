import {
  Controller,
  Inject,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  AiAbortSignal,
  type AiStreamResult,
  AiStream,
} from '@nest-native/ai-sdk';
import { streamText } from 'ai';
import { AuthGuard } from '../../auth/auth.guard';
import { ActivityService } from '../activity/activity.service';
import { ProjectsService } from '../projects/projects.service';
import { buildActivityPrompt, buildStatusSummary } from './activity-digest';
import { resolveAssistantModel } from './assistant-model';

/**
 * Streaming AI "project assistant".
 *
 * `POST /projects/:projectId/assistant` reads the project's recent activity
 * feed (scoped to the caller's tenant) and streams back a status-update summary
 * as an AI SDK UI-message stream (SSE) via `@AiStream`.
 *
 * Because `@AiStream` is an interceptor, the guard and pipe run *before* the
 * stream opens: an unauthenticated caller gets a plain `401`, a non-numeric id
 * a `400`, and a project outside the caller's org a `404` — real HTTP errors,
 * never mid-stream error frames. Only once tenant scoping has passed does the
 * response become a stream.
 *
 * `@AiAbortSignal()` is forwarded to `streamText` so a client disconnect
 * mid-stream cancels the upstream model request instead of billing for tokens
 * written to a dead socket.
 */
@Controller('projects')
export class ProjectAssistantController {
  constructor(
    @Inject(ProjectsService) private readonly projects: ProjectsService,
    @Inject(ActivityService) private readonly activity: ActivityService,
  ) {}

  @Post(':projectId/assistant')
  @AiStream()
  @UseGuards(AuthGuard)
  async summarize(
    @Param('projectId', ParseIntPipe) projectId: number,
    @AiAbortSignal() signal: AbortSignal,
  ): Promise<AiStreamResult> {
    // Tenant scoping lives in ProjectsService.get(): it throws `NotFound` when
    // there is no active organization and `404` when the project belongs to a
    // different org, so the stream only ever opens for a project the caller may
    // read. It also yields the project name for the digest header.
    const project = this.projects.get(projectId);
    const events = this.activity.list(project.orgId, project.id);

    const prompt = buildActivityPrompt(project.name, events);
    const summary = buildStatusSummary(project.name, events);
    const model = await resolveAssistantModel(summary);

    return streamText({ model, prompt, abortSignal: signal });
  }
}
