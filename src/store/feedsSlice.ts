import type { StateCreator } from 'zustand';
import type { ProjectSummary, ProjectSnapshot } from '../services/projectsApi';

export interface PublicationEntry {
  id: string;
  snapshotId: string | null;
  action: string;
  actorUserId: string | null;
  createdAt: number;
}

export interface PublicationCurrent {
  snapshotId: string;
  publishedAt: number;
  canonicalUrl?: string;
}

export interface DraftLinkEntry {
  tokenHash: string;
  snapshotId: string;
  expiresAt: number;
  createdAt: number;
}

/**
 * The "opened to a blank canvas, but the content is somewhere" state.
 *
 * Set by loadProjectFromServer when a server feed's live working state resolves
 * to nothing AND that is alarming — i.e. saved versions exist to recover from,
 * or the working-state blob is outright missing. A brand-new feed with nothing
 * saved yet is the normal case and deliberately does NOT set this.
 */
export interface EmptyWorkingStateWarning {
  /** How many saved versions the feed has (may be 0 when reason is blob_missing). */
  snapshotCount: number;
  /**
   * no_content   — a working state exists (or was never saved) and it carries
   *                no routes/stops/trips, while versions hold real content.
   * blob_missing — the server has a working-state key on file but its R2 object
   *                is gone. Real data loss; should never happen.
   */
  reason: 'no_content' | 'blob_missing';
}

export interface FeedsSlice {
  feedsProjects: ProjectSummary[];
  feedsQuotaWarning: string | null;
  feedsLoaded: boolean;
  activeServerProjectId: string | null;
  workingStateVersion: number;
  snapshotList: ProjectSnapshot[];
  restoredBanner: string | null;
  emptyWorkingState: EmptyWorkingStateWarning | null;
  publicationHistory: PublicationEntry[];
  currentPublication: PublicationCurrent | null;
  draftLinks: DraftLinkEntry[];
  setFeedsProjects: (projects: ProjectSummary[], warning: string | null) => void;
  upsertFeedProject: (project: ProjectSummary) => void;
  removeFeedProject: (projectId: string) => void;
  setActiveServerProject: (projectId: string | null) => void;
  setWorkingStateVersion: (version: number) => void;
  setSnapshotList: (snapshots: ProjectSnapshot[]) => void;
  setRestoredBanner: (msg: string | null) => void;
  setEmptyWorkingState: (warning: EmptyWorkingStateWarning | null) => void;
  setPublicationHistory: (history: PublicationEntry[]) => void;
  setCurrentPublication: (current: PublicationCurrent | null) => void;
  setDraftLinks: (links: DraftLinkEntry[]) => void;
}

export const createFeedsSlice: StateCreator<
  FeedsSlice,
  [['zustand/immer', never]],
  [],
  FeedsSlice
> = (set) => ({
  feedsProjects: [],
  feedsQuotaWarning: null,
  feedsLoaded: false,
  activeServerProjectId: null,
  workingStateVersion: 0,
  snapshotList: [],
  restoredBanner: null,
  emptyWorkingState: null,
  publicationHistory: [],
  currentPublication: null,
  draftLinks: [],

  setFeedsProjects: (projects, warning) =>
    set((state) => {
      state.feedsProjects = projects;
      state.feedsQuotaWarning = warning;
      state.feedsLoaded = true;
    }),

  upsertFeedProject: (project) =>
    set((state) => {
      const idx = state.feedsProjects.findIndex((p) => p.id === project.id);
      if (idx === -1) state.feedsProjects.unshift(project);
      else state.feedsProjects[idx] = { ...state.feedsProjects[idx], ...project };
    }),

  removeFeedProject: (projectId) =>
    set((state) => {
      state.feedsProjects = state.feedsProjects.filter((p) => p.id !== projectId);
    }),

  setActiveServerProject: (projectId) =>
    set((state) => {
      state.activeServerProjectId = projectId;
      if (projectId === null) {
        state.workingStateVersion = 0;
        state.snapshotList = [];
        // Feed-scoped warning — must not follow the user to the next feed.
        state.emptyWorkingState = null;
        state.publicationHistory = [];
        state.currentPublication = null;
        state.draftLinks = [];
      }
    }),

  setWorkingStateVersion: (version) =>
    set((state) => {
      state.workingStateVersion = version;
    }),

  setSnapshotList: (snapshots) =>
    set((state) => {
      state.snapshotList = snapshots;
    }),

  setRestoredBanner: (msg) =>
    set((state) => {
      state.restoredBanner = msg;
    }),

  setEmptyWorkingState: (warning) =>
    set((state) => {
      state.emptyWorkingState = warning;
    }),

  setPublicationHistory: (history) =>
    set((state) => {
      state.publicationHistory = history;
    }),

  setCurrentPublication: (current) =>
    set((state) => {
      state.currentPublication = current;
    }),

  setDraftLinks: (links) =>
    set((state) => {
      state.draftLinks = links;
    }),
});
