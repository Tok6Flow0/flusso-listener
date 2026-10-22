import { GitHubProvider } from 'electron-updater';

const ARCHITECTURE_CHANNEL = /^(preview|latest)-(arm64|x64)$/;

export class ArchitectureGitHubProvider extends GitHubProvider {
  getCustomChannelName(channel) {
    const configured = this.options.channel;
    const match = typeof configured === 'string' && ARCHITECTURE_CHANNEL.exec(configured);
    // The upstream prerelease lookup reduces preview-arm64 to preview. Keep
    // builder's architecture on that lookup and its stable fallback, retaining
    // the library's release selection and platform suffix rules.
    return super.getCustomChannelName(match && ['preview', 'latest'].includes(channel) ? `${channel}-${match[2]}` : channel);
  }
}

export function configureArchitectureProvider(updater) {
  // Small updater adapters without disk configuration keep their existing feed.
  if (!updater.configOnDisk || typeof updater.setFeedURL !== 'function') return;
  return updater.configOnDisk.value.then(config => {
    if (config.provider !== 'github' || config.private || config.token || !ARCHITECTURE_CHANNEL.test(config.channel ?? '')) return;
    // Reuse the packaged ownership, host, channel and trust configuration. Only
    // the channel filename mapping changes; release selection and signature
    // verification remain in the installed updater library.
    updater.setFeedURL({ ...config, provider: 'custom', updateProvider: ArchitectureGitHubProvider });
  });
}
