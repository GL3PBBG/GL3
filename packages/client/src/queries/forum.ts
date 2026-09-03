import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  ForumListResponseSchema,
  ForumTopicListResponseSchema,
  ForumTopicViewResponseSchema,
  type CreatePostRequest,
  type CreateTopicRequest,
  type ForumListResponse,
  type ForumTopicListResponse,
  type ForumTopicViewResponse,
} from "@gl3/shared";
import { api } from "../api/client.js";
import { keys } from "../api/keys.js";

// ---------------------------------------------------------------------------
// Forum
// ---------------------------------------------------------------------------

export function useForums() {
  return useQuery<ForumListResponse>({
    queryKey: keys.forums(),
    queryFn: async () => ForumListResponseSchema.parse(await api("/api/forum")),
  });
}

export function useForumTopics(forumId: string, page: number) {
  return useQuery<ForumTopicListResponse>({
    queryKey: keys.forumTopics(forumId, page),
    queryFn: async () =>
      ForumTopicListResponseSchema.parse(await api(`/api/forum/${forumId}/topics?page=${page}`)),
  });
}

export function useForumTopic(topicId: string, page: number) {
  return useQuery<ForumTopicViewResponse>({
    queryKey: keys.forumTopic(topicId, page),
    queryFn: async () =>
      ForumTopicViewResponseSchema.parse(await api(`/api/forum/topics/${topicId}?page=${page}`)),
  });
}

/** Opens a topic (and its first post) in one call. 429 `on_cooldown` carries
 *  `retryAfter` — the 60s per-player topic cooldown. */
export function useCreateTopic(forumId: string) {
  const queryClient = useQueryClient();
  return useMutation<{ topicId: string }, Error, CreateTopicRequest>({
    mutationFn: async (input) =>
      z.object({ topicId: z.string() }).parse(
        await api(`/api/forum/${forumId}/topics`, { method: "POST", body: JSON.stringify(input) }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.forumTopicsAll(forumId) });
      // topicCount on the forum list moved too.
      void queryClient.invalidateQueries({ queryKey: keys.forums() });
    },
  });
}

/** Replies to a topic. 429 `on_cooldown` carries `retryAfter` — the 15s
 *  per-player post cooldown; 409 `topic_locked` when a moderator closed it. */
export function useCreatePost(topicId: string) {
  const queryClient = useQueryClient();
  return useMutation<{ postId: string }, Error, CreatePostRequest>({
    mutationFn: async (input) =>
      z.object({ postId: z.string() }).parse(
        await api(`/api/forum/topics/${topicId}/posts`, { method: "POST", body: JSON.stringify(input) }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.forumTopicAll(topicId) });
      // `postCount`/`lastPostAt` on some forum's topic list moved too, and this
      // hook doesn't know which forum that is — ForumTopicSchema carries no
      // `forumId` — so the whole prefix goes rather than a key it can't build.
      void queryClient.invalidateQueries({ queryKey: keys.forum() });
    },
  });
}

/** Moderator-only (`forum` or `*` grant), checked server-side too. */
export function useLockTopic(topicId: string) {
  const queryClient = useQueryClient();
  return useMutation<void, Error, boolean>({
    mutationFn: async (locked) =>
      api<void>(`/api/forum/topics/${topicId}/lock`, {
        method: "POST", body: JSON.stringify({ locked }),
      }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: keys.forumTopicAll(topicId) }); },
  });
}

/** Moderator-only. Sets a topic sticky or normal. */
export function useSetTopicType(topicId: string) {
  const queryClient = useQueryClient();
  return useMutation<void, Error, "normal" | "sticky">({
    mutationFn: async (type) =>
      api<void>(`/api/forum/topics/${topicId}/type`, {
        method: "POST", body: JSON.stringify({ type }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.forumTopicAll(topicId) });
      // Sort order (sticky-first) on the forum's topic list moved too.
      void queryClient.invalidateQueries({ queryKey: keys.forum() });
    },
  });
}

/** Moderator-only. Deletes one post; `postId` is the mutation input. */
export function useDeletePost(topicId: string) {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (postId) => api<void>(`/api/forum/posts/${postId}`, { method: "DELETE" }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: keys.forumTopicAll(topicId) }); },
  });
}

/** Moderator-only. Deletes a whole topic — its posts cascade server-side. */
export function useDeleteTopic() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (topicId) => api<void>(`/api/forum/topics/${topicId}`, { method: "DELETE" }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: keys.forum() }); },
  });
}
