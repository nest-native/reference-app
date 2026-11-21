import type { ServerResponse } from 'node:http';
import {
  Controller,
  Inject,
  Param,
  ParseIntPipe,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { pipeUIMessageStreamToResponse, streamText } from 'ai';
import { AuthGuard } from '../../auth/auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { ActivityService } from '../activity/activity.service';
import { ProjectsService } from '../projects/projects.service';
import { buildActivityPrompt, buildStatusSummary } from './activity-digest';
import { resolveAssistantModel } from './assistant-model';

/**
 * Streaming AI "project assistant".
 *
 * `POST /projects/:projectId/assistant` reads the project's recent activity
 * feed (scoped to the caller's tenant) and streams back a status-update summary
 * as an AI SDK UI-message stream (SSE). The handler takes the response with
 * `@Res()` and hands `streamText`'s stream to the AI SDK's own
 * `pipeUIMessageStreamToResponse()`, with no library in between. The official
 * `@nestjs/ai` does this on NestJS 12, and the assistant moves to it when the
 * app does.
 *
 * The guards and the pipe run before the handler, and the handler does
 * everything that can throw (tenant scoping, the feed read, choosing the model)
 * before it writes to the response. So an unauthenticated caller gets a plain
 * `401`, a non-numeric id a `400`, and a project outside the caller's org a
 * `404` — real HTTP errors, never mid-stream error frames. Only once tenant
 * scoping has passed does the response become a stream. A model that fails
 * after that ends the stream with the AI SDK's error frame, whose text stays
 * the SDK's default `An error occurred.`, so no provider detail leaks.
 *
 * `RolesGuard` runs alongside `AuthGuard` for the same reason: this endpoint
 * spends model tokens on a tenant's activity feed, so a caller whose membership
 * was revoked must lose it on their next request, not at token expiry.
 *
 * A client that disconnects before the response finishes aborts the signal
 * passed to `streamText`, which cancels the upstream model request instead of
 * billing for tokens written to a dead socket.
 */
@Controller('projects')
export class ProjectAssistantController {
  constructor(
    @Inject(ProjectsService) private readonly projects: ProjectsService,
    @Inject(ActivityService) private readonly activity: ActivityService,
  ) {}

  @Post(':projectId/assistant')
  @UseGuards(AuthGuard, RolesGuard)
  async summarize(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Res() res: ServerResponse,
  ): Promise<void> {
    // Tenant scoping lives in ProjectsService.get(): it throws `NotFound` when
    // there is no active organization and `404` when the project belongs to a
    // different org, so the stream only ever opens for a project the caller may
    // read. It also yields the project name for the digest header.
    const project = this.projects.get(projectId);
    const events = this.activity.list(project.orgId, project.id);

    const prompt = buildActivityPrompt(project.name, events);
    const summary = buildStatusSummary(project.name, events);
    const model = await resolveAssistantModel(summary);

    // A client that goes away stops the model call. `close` has already been
    // emitted when it left while the handler was still reading, so check that
    // case too.
    const abort = new AbortController();
    const stopModel = (): void => {
      if (!res.writableFinished) abort.abort();
    };
    if (res.destroyed) stopModel();
    else res.once('close', stopModel);

    const result = streamText({ model, prompt, abortSignal: abort.signal });
    await pipeUIMessageStreamToResponse({
      response: res,
      stream: result.toUIMessageStream(),
    });
  }
}
