const { Structures, Utils } = require('detritus-client');
const { ClientEvents, DiscordRegexNames } = require('detritus-client/lib/constants');
const { Timers } = require('detritus-utils');


const MAX_PAGE = Number.MAX_SAFE_INTEGER;
const MIN_PAGE = 1;

const PageEmojis = Object.freeze({
  custom: '🔢',
  info: 'ℹ',
  next: '➡',
  nextDouble: '⏭',
  previous: '⬅',
  previousDouble: '⏮',
  stop: '⏹',
});



class Paginator {
  constructor(context, options) {
    this.context = context;
    this.message = options.message || null;

    this.custom = {expire: 10000, timeout: new Timers.Timeout()};
    this.emojis = {};
    this.expires = 60000;
    this.isOnGuide = false;
    this.message = null;
    this.page = MIN_PAGE;
    this.pageLimit = MAX_PAGE;
    this.pageSkipAmount = 10;
    this.ratelimit = 1500;
    this.ratelimitTimeout = new Timers.Timeout();
    this.stopped = false;
    this.subscriptions = [];
    this.targets = [];
    this.timeout = new Timers.Timeout();

    if (options.pageLimit !== undefined) {
      this.pageLimit = Math.max(MIN_PAGE, Math.min(options.pageLimit || MIN_PAGE, MAX_PAGE));
    }

    if (Array.isArray(options.targets)) {
      for (let target of options.targets) {
        if (typeof(target) === 'string') {
          this.targets.push(target);
        } else {
          this.targets.push(target.id);
        }
      }
    } else {
      if (context instanceof Structures.Message) {
        this.targets.push(context.author.id);
      } else {
        this.targets.push(context.userId);
      }
    }

    if (!this.targets.length) {
      throw new Error('A userId must be specified in the targets array');
    }

    const emojis = Object.assign({}, PageEmojis, options.emojis);
    for (let key in PageEmojis) {
      const value = emojis[key];
      if (typeof(value) === 'string') {
        let emoji;
        const { matches } = Utils.regex(DiscordRegexNames.EMOJI, value);
        if (matches.length) {
          emoji = new Structures.Emoji(context.client, matches[0]);
        } else {
          emoji = new Structures.Emoji(context.client, {name: value});
        }
        this.emojis[key] = emoji;
      }
      if (!(this.emojis[key] instanceof Structures.Emoji)) {
        throw new Error(`Emoji for ${key} must be a string or Emoji structure`);
      }
    }

    this.onError = options.onError;
    this.onExpire = options.onExpire;
    this.onPage = options.onPage;
    this.onPageNumber = options.onPageNumber;
  }

  get isLarge() {
    return this.pageSkipAmount < this.pageLimit;
  }

  async clearCustomMessage() {
    this.custom.timeout.stop();
    if (this.custom.message) {
      try {
        await this.custom.message.delete();
      } catch(error) {}
      this.custom.message = null;
    }
  }

  async getGuidePage() {
    const embed = new Utils.Embed();
    embed.setTitle('Interactive Paginator Guide');
    embed.setDescription([
      'This allows you to navigate through pages of text using reactions.\n',
      `${this.emojis.previous} - Goes back one page`,
      `${this.emojis.next} - Goes forward one page`,
      `${this.emojis.custom} - Allows you to choose a number via text`,
      `${this.emojis.stop} - Stops the paginator`,
      `${this.emojis.info} - Shows this guide`,
    ].join('\n'));
    embed.setFooter(`We were on page ${this.page.toLocaleString()}.`);
    return embed;
  }

  async getPage(page) {
    if (typeof(this.onPage) === 'function') {
      return await Promise.resolve(this.onPage(this.page));
    }
    if (Array.isArray(this.pages)) {
      page -= 1;
      if (page in this.pages) {
        return this.pages[page];
      }
    }
    throw new Error(`Page ${page} not found`);
  }

  async setPage(page) {
    if (this.message && (this.isOnGuide || page !== this.page)) {
      this.isOnGuide = false;
      this.page = page;
      const embed = await this.getPage(page);
      await this.message.edit({embed});
    }
  }

  async onMessageReactionAdd({messageId, reaction, userId}) {
    if (this.stopped) {
      return;
    }
    if (!this.message || this.message.id !== messageId) {
      return;
    }
    if (!this.targets.includes(userId) && !this.context.client.isOwner(userId)) {
      return;
    }
    if (this.ratelimitTimeout.hasStarted) {
      return;
    }

    try {
      switch (reaction.emoji.endpointFormat) {
        case this.emojis.previousDouble.endpointFormat: {
          if (!this.isLarge) {
            return;
          }
          const page = Math.max(this.page - this.pageSkipAmount, MIN_PAGE);
          await this.setPage(page);
        }; break;
        case this.emojis.previous.endpointFormat: {
          const page = this.page - 1;
          if (MIN_PAGE <= page) {
            await this.setPage(page);
          }
        }; break;

        case this.emojis.next.endpointFormat: {
          const page = this.page + 1;
          if (page <= this.pageLimit) {
            await this.setPage(page);
          }
        }; break;
        case this.emojis.nextDouble.endpointFormat: {
          if (!this.isLarge) {
            return;
          }
          const page = Math.min(this.page + this.pageSkipAmount, this.pageLimit);
          await this.setPage(page);
        }; break;

        case this.emojis.custom.endpointFormat: {
          if (!this.custom.message) {
            await this.clearCustomMessage();
            this.custom.message = await this.message.reply('What page would you like to go to?');
            this.custom.timeout.start(this.custom.expire, async () => {
              await this.clearCustomMessage();
            });
          }
        }; break;
        case this.emojis.stop.endpointFormat: {
          await this.onStop();
        }; break;
        case this.emojis.info.endpointFormat: {
          if (!this.isOnGuide) {
            this.isOnGuide = true;
            const embed = await this.getGuidePage();
            await this.message.edit({embed});
          }
        }; break;
        default: {
          return;
        };
      }

      this.timeout.start(this.expires, this.onStop.bind(this));
      this.ratelimitTimeout.start(this.ratelimit, () => {});
      /*
      if (this.message.canManage) {
        await reaction.delete(userId);
      }
      */
    } catch(error) {
      if (typeof(this.onError) === 'function') {
        await Promise.resolve(this.onError(error, this));
      }
    }
  }

  async onStop(error, clearEmojis = true) {
    this.reset();
    if (!this.stopped) {
      this.stopped = true;
      try {
        if (error) {
          if (typeof(this.onError) === 'function') {
            await Promise.resolve(this.onError(error, this));
          }
        }
        if (typeof(this.onExpire) === 'function') {
          await Promise.resolve(this.onExpire(this));
        }
      } catch(error) {
        if (typeof(this.onError) === 'function') {
          await Promise.resolve(this.onError(error, this));
        }
      }
      if (clearEmojis) {
        if (this.message && this.message.canManage) {
          try {
            await this.message.deleteReactions();
          } catch(error) {}
        }
      }
      await this.clearCustomMessage();

      this.onError = undefined;
      this.onExpire = undefined;
      this.onPage = undefined;
      this.onPageNumber = undefined;
    }
  }

  reset() {
    this.timeout.stop();
    this.custom.timeout.stop();
    this.ratelimitTimeout.stop();
    for (let subscription of this.subscriptions) {
      subscription.remove();
    }
    this.subscriptions.length = 0;
  }

  async start() {
    if (typeof(this.onPage) !== 'function' && !(this.pages && this.pages.length)) {
      throw new Error('Paginator needs an onPage function or at least one page added to it');
    }

    let message;
    if (this.message) {
      message = this.message;
    } else {
      if (!this.context.canReply) {
        throw new Error('Cannot create messages in this channel');
      }
      const embed = await this.getPage(this.page);
      message = this.message = await this.context.reply({embed});
    }

    this.reset();
    if (!this.stopped && this.pageLimit !== MIN_PAGE && message.canReact) {
      {
        const subscription = this.context.cluster.subscribe(ClientEvents.GUILD_DELETE, async (event) => {
          const { guild } = event;

          if (this.context.guildId === guild.id) {
            this.message = null;
            this.custom.message = null;
            this.stop(false);
          }
        });
        this.subscriptions.push(subscription);
      }
      {
        const subscription = this.context.cluster.subscribe(ClientEvents.CHANNEL_DELETE, async (event) => {
          const { channel } = event;

          if (this.context.channelId === channel.id) {
            this.message = null;
            this.custom.message = null;
            this.stop(false);
          }
        });
        this.subscriptions.push(subscription);
      }
      {
        const subscription = this.context.cluster.subscribe(ClientEvents.MESSAGE_CREATE, async (event) => {
          const { message } = event;

          if (this.custom.message && (this.targets.includes(message.author.id) || message.author.isClientOwner)) {
            let page = parseInt(message.content);
            if (!isNaN(page)) {
              page = Math.max(MIN_PAGE, Math.min(page, this.pageLimit));
              await this.clearCustomMessage();
              if (message.canDelete) {
                try {
                  await message.delete();
                } catch(error) {}
              }
              this.setPage(page);
            }
          }
        });
        this.subscriptions.push(subscription);
      }
      {
        const subscription = this.context.cluster.subscribe(ClientEvents.MESSAGE_DELETE, async (event) => {
          const { messageId } = event;

          if (this.message) {
            if (this.message.id === messageId) {
              this.message = null;
              this.stop(false);
            }
          }
          if (this.custom.message) {
            if (this.custom.message.id === messageId) {
              this.custom.message = null;
              this.clearCustomMessage();
            }
          }
        });
        this.subscriptions.push(subscription);
      }
      {
        const subscription = this.context.cluster.subscribe(ClientEvents.MESSAGE_REACTION_ADD, async (event) => {
          const { channelId } = event;
          if (this.context.channelId === channelId) {
            this.onMessageReactionAdd(event);
          }
        });
        this.subscriptions.push(subscription);
      }
      {
        const subscription = this.context.cluster.subscribe(ClientEvents.MESSAGE_REACTION_REMOVE, async (event) => {
          const { channelId } = event;
          if (this.context.channelId === channelId) {
            this.onMessageReactionAdd(event);
          }
        });
        this.subscriptions.push(subscription);
      }
      {
        const subscription = this.context.cluster.subscribe(ClientEvents.MESSAGE_REACTION_REMOVE_ALL, async (event) => {
          const { channelId, messageId } = event;
          if (this.context.channelId === channelId && this.message && this.message.id === messageId) {
            this.stop(false);
          }
        });
        this.subscriptions.push(subscription);
      }

      setImmediate(async () => {
        try {
          this.timeout.start(this.expires, this.onStop.bind(this));
          const emojis = [
            (this.isLarge) ? this.emojis.previousDouble : null,
            this.emojis.previous,
            this.emojis.next,
            (this.isLarge) ? this.emojis.nextDouble : null,
            this.emojis.custom,
            this.emojis.stop,
            this.emojis.info,
          ].filter((v) => v);

          for (let emoji of emojis) {
            if (this.stopped || message.deleted) {
              break;
            }
            if (message.reactions.has(emoji.id || emoji.name)) {
              continue;
            }
            await message.react(emoji.endpointFormat);
          }
        } catch(error) {
          if (typeof(this.onError) === 'function') {
            this.onError(error, this);
          }
        }
      });
    }

    return message;
  }

  stop(clearEmojis = true) {
    return this.onStop(null, clearEmojis);
  }
}

module.exports = { Paginator };
