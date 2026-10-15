import type {
  CreatorRuntimeComponent,
  CreatorRuntimeComponentsResponse,
  CreatorYtDlpStatusResponse,
  HongguoComponentStatusResponse
} from '@opencreator/protocol';

type ClientLike = {
  get(path: string): Promise<unknown>;
  post(path: string, body?: unknown): Promise<unknown>;
};

export function createRuntimeDependencyService(client: ClientLike) {
  return {
    getComponentsStatus(): Promise<CreatorRuntimeComponentsResponse> {
      return client.get('/creator/components/status') as Promise<CreatorRuntimeComponentsResponse>;
    },
    downloadComponents(componentId?: CreatorRuntimeComponent['id']): Promise<CreatorRuntimeComponentsResponse> {
      return client.post('/creator/components/download', componentId === undefined ? undefined : { componentId }) as Promise<CreatorRuntimeComponentsResponse>;
    },
    getYtDlpStatus(): Promise<CreatorYtDlpStatusResponse> {
      return client.get('/creator/yt-dlp/status') as Promise<CreatorYtDlpStatusResponse>;
    },
    checkYtDlpUpdate(force = true): Promise<CreatorYtDlpStatusResponse> {
      return client.post(
        '/creator/yt-dlp/check',
        { force }
      ) as Promise<CreatorYtDlpStatusResponse>;
    },
    updateYtDlp(): Promise<CreatorYtDlpStatusResponse> {
      return client.post('/creator/yt-dlp/update') as Promise<CreatorYtDlpStatusResponse>;
    },
    getHongguoStatus(): Promise<HongguoComponentStatusResponse> {
      return client.get('/creator/hongguo/status') as Promise<HongguoComponentStatusResponse>;
    },
    checkHongguoUpdate(force = true): Promise<HongguoComponentStatusResponse> {
      return client.post(
        '/creator/hongguo/check',
        { force }
      ) as Promise<HongguoComponentStatusResponse>;
    },
    updateHongguo(): Promise<HongguoComponentStatusResponse> {
      return client.post('/creator/hongguo/update') as Promise<HongguoComponentStatusResponse>;
    },
    launchHongguo(): Promise<HongguoComponentStatusResponse> {
      return client.post('/creator/hongguo/launch') as Promise<HongguoComponentStatusResponse>;
    }
  };
}

export type RuntimeDependencyService = ReturnType<typeof createRuntimeDependencyService>;
