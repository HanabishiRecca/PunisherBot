'use strict';

require('./log.js');

const Shutdown = err => {
    console.error(err);
    console.log('SHUTDOWN');
    process.exit(1);
};

process.on('uncaughtException', Shutdown);
process.on('unhandledRejection', Shutdown);

!process.env.TOKEN && Shutdown('Token required.');

const storagePath = process.env.STORAGE;
!storagePath && Shutdown('Storage path required.');

global.gc && setInterval(global.gc, 3600000);

const
    Database = require('nedb-promise'),
    Discord = require('discord-slim'),
    Util = require('./util.js'),
    config = require('./config.json'),
    fs = require('fs');

const
    blacklistDb = new Database({ filename: `${storagePath}/blacklist.db`, autoload: true }),
    serversDb = new Database({ filename: `${storagePath}/servers.db`, autoload: true }),
    categoriesDb = new Database({ filename: `${storagePath}/categories.db`, autoload: true }),
    hooksDb = new Database({ filename: `${storagePath}/hooks.db`, autoload: true });

const client = new Discord.Client();

const StatusTracker = require('http').createServer((_, res) => res.end('ONLINE'));

client.on('connect', () => {
    console.log('Connection established.');
    !StatusTracker.listening && StatusTracker.listen(21240);
});
client.on('disconnect', code => {
    console.error(`Disconnect. (${code})`);
    StatusTracker.close();
});
client.on('warn', console.warn);
client.on('error', console.error);
client.on('fatal', Shutdown);

const
    Routes = Discord.Routes,
    Permissions = Discord.Permissions,
    ConnectedServers = new Map(),
    SuspiciousUsers = new Map(),
    SafePromise = promise => new Promise(resolve => promise.then(result => resolve(result)).catch(error => { console.warn(error); resolve(null); }));

const
    BanUser = (server, user, reason) => client.Request('put', `${Routes.Server(server)}/bans/${user.id || user}?delete-message-days=1&reason=${encodeURI(reason)}`),
    CreateWebhook = (channel, name, avatar) => client.Request('post', Routes.Channel(channel) + '/webhooks', { name, avatar }),
    DeleteMessage = message => client.Request('delete', Routes.Message(message.channel_id, message)),
    GetBans = server => client.Request('get', Routes.Server(server) + '/bans'),
    GetInvite = code => client.Request('get', Routes.Invite(code)),
    GetServerInvites = server => client.Request('get', Routes.Server(server) + '/invites'),
    GetUser = userId => client.Request('get', Routes.User(userId)),
    GetUserChannel = user => client.Request('post', Routes.User('@me') + '/channels', { recipient_id: user.id || user }),
    GetWebhook = (id, token) => client.Request('get', Routes.Webhook(id, token)),
    SendMessage = (channel, content, embed) => client.Request('post', Routes.Channel(channel) + '/messages', { content, embed }),
    SendWebhookMessage = (id, token, username, avatar_url, content, embed) => client.Request('post', Routes.Webhook(id, token), { username, avatar_url, content, embeds: embed ? [embed] : undefined }),
    UnbanUser = (server, user) => client.Request('delete', `${Routes.Server(server)}/bans/${user.id || user}`);

const
    CheckPermission = (permissions, flag) => ((permissions & Permissions.ADMINISTRATOR) > 0) || ((permissions & flag) === flag),
    MessageContent = str => `**Содержимое сообщения**\`\`\`${str}\`\`\``,
    MessageUrl = (server, channel, message) => `${Discord.Host}/channels/${server.id || server}/${channel.id || channel}/${message.id || message}`,
    NoAvatar = discriminator => `${Discord.CDN}/embed/avatars/${parseInt(discriminator) % 5}.png`,
    ServerToText = server => `\`${server.name}\` (${server.id})`,
    TagNotExist = tag => `тег \`${tag}\` не существует.`,
    UserAvatar = user => `${Discord.CDN}/avatars/${user.id}/${user.avatar}`,
    UserMention = user => `<@${user.id || user}>`,
    UserNotExist = id => `пользователь с идентификатором \`${id}\` не существует.`,
    UserTag = user => `**${user.username}**\`#${user.discriminator}\``,
    UserToText = user => `${UserMention(user)} (${UserTag(user)})`;

const HasPermission = (member, flag) => {
    if(member.user.id == member.server.owner_id)
        return true;

    const
        serverRoles = member.server.roles,
        roles = member.roles;

    for(let i = 0; i < roles.length; i++) {
        const role = serverRoles.get(roles[i]);
        if(role && CheckPermission(role.permissions, flag))
            return true;
    }

    return false;
};

const
    IsAdmin = member => HasPermission(member, Permissions.MANAGE_CHANNELS),
    IsModer = member => HasPermission(member, Permissions.MANAGE_MESSAGES),
    ServiceLog = msg => SendMessage(config.serviceChannel, msg);

const TryBan = async (server, user, reason) => {
    try {
        await BanUser(server, user, reason);
    } catch(e) {
        await Notify(server, `Не удалось забанить пользователя ${UserToText(user)}!\n${e.code} ${e.message}`);
        return false;
    }
    return true;
};

const TryUnban = async (server, user) => {
    try {
        await UnbanUser(server, user);
    } catch(e) {
        if(e.code == 404) return true;
        await Notify(server, `Не удалось разбанить пользователя ${UserToText(user)}!\n${e.code} ${e.message}`);
        return false;
    }
    return true;
};

const SendInfo = async (server, msg) => {
    const serverInfo = await serversDb.findOne({ _id: server.id });
    if(!(serverInfo && serverInfo.channel))
        return;

    try {
        await SendMessage(serverInfo.channel, msg);
    } catch(e) {
        ServiceLog(`На сервере ${ServerToText(server)} не удалось отправить сообщение в сервисный канал!\n${e.code} ${e.message}`);
    }
};

const Notify = (server, msg) => {
    if(server.id != config.mainServer)
        ServiceLog(`**Сервер:** ${ServerToText(server)}\n**Событие:**\n${msg}`);
    SendInfo(server, msg);
};

const TryDeleteMessage = async message => {
    try {
        await DeleteMessage(message);
    } catch(e) {
        Notify(message.server, `**Не удалось удалить сообщение!**\n${e.code} ${e.message}\n\n${MessageUrl(message.server, message.channel_id, message)}`);
    }
};

const SendPM = async (user, msg) => await SafePromise(SendMessage(await GetUserChannel(user), msg));

const SendNews = async (tag, content, embed) => {
    const
        channels = new Set(),
        hooks = await hooksDb.find({});

    hooks.forEach(async hookInfo => {
        const hook = await SafePromise(GetWebhook(hookInfo._id, hookInfo.token));
        if(!hook) {
            hooksDb.remove({ _id: hookInfo._id });
            hooksDb.persistence.compactDatafile();
            return;
        }

        if(channels.has(hook.channel_id))
            return;

        if(hookInfo.tags && hookInfo.tags.length && (hookInfo.tags.indexOf(tag) < 0))
            return;

        const cat = await categoriesDb.findOne({ _id: tag });
        if(!cat)
            return;

        SendWebhookMessage(hookInfo._id, hookInfo.token, cat.name || client.user.username, cat.avatar || client.user.avatarURL, content || '', embed);
        channels.add(hook.channel_id);
    });
};

const PushServerList = async () => {
    if(!process.env.WEB_DIR)
        return;

    for(const server of ConnectedServers.values())
        if(!server.name)
            return;

    const output = [];
    for(const server of ConnectedServers.values())
        output.push({
            id: server.id,
            name: server.name,
            users: server.member_count,
            image: server.icon,
            trusted: server.trusted,
        });

    fs.writeFileSync(`${process.env.WEB_DIR}/servers.json`, JSON.stringify(output));
};

const PushBlacklist = async () => {
    if(!process.env.WEB_DIR)
        return;

    const
        bans = await GetBans(config.mainServer),
        output = [];

    for(let i = 0; i < bans.length; i++) {
        const
            banInfo = bans[i],
            userInfo = await blacklistDb.findOne({ _id: banInfo.user.id });

        if(!userInfo)
            continue;

        output.push({
            id: banInfo.user.id,
            username: banInfo.user.username,
            discriminator: banInfo.user.discriminator,
            avatar: banInfo.user.avatar,
            reason: userInfo.reason,
        });
    }

    fs.writeFileSync(`${process.env.WEB_DIR}/blacklist.json`, JSON.stringify(output));
};

setInterval(PushBlacklist, 3600000);

const
    headerHelp = `**Информационная панель бота**\n${config.panelUrl}`,

    userHelp = `**Команды пользователя**
\`link\` - показать ссылку на приглашение бота.
\`info @user\` - показать информацию об указанном пользователе.
\`help\` - показать данное справочное сообщение.`,

    moderHelp = `**Команды модератора**
\`stats\` - показать количество серверов и банов.
\`blacklist\` - показать список всех пользователей в черном списке.
\`serverlist\` - показать список всех подключенных серверов.`,

    adminHelp = `**Команды администратора**
\`channel #канал\` - установка канала для информационных сообщений бота. Если канал не указан, параметр будет очищен.
\`subscribe $tag\` - подписаться на категории с указанными тегами. Если теги не указаны, будет осуществлена подписка на все категории.
\`tags\` - показать список всех доступных новостных категорий.
\`strict\` - включить/отключить строгий режим.`,

    serviceHelp = `**Сервисные команды**
\`ban @user причина\` - добавить указанного пользователя в черный список с указанием причины.
\`unban @user\` - убрать указанного пользователя из черного списка.
\`trust id\` - добавить сервер с указанным идентификатором в доверенные.
\`untrust id\` - убрать сервер с указанным идентификатором из доверенных.
\`post $tag {...}\` - разместить новость в указанную категорию с указанным телом сообщения (JSON). Конструктор тела сообщения: <https://leovoel.github.io/embed-visualizer/>
\`hooks\` - показать список всех активных подписок (вебхуков).
\`addcat {...}\` - добавить категорию с указанными параметрами. Параметры представляют из себя объект JSON с полями tag, name и avatar.
\`removecat $tag\` - удалить категорию с указанным тегом.
\`dumpcat $tag\` - показать информацию о категории с указанным тегом.`;

const botCommands = {
    channel: async message => {
        if(!IsAdmin(message.member))
            return;

        const channelId = Util.GetFirstChannelMention(message.content);
        if(channelId) {
            try {
                await SendMessage(channelId, 'Канал установлен.');
            } catch(e) {
                message.reply(`нет доступа к указанному каналу!\n${e.code} ${e.message}`, true);
                return;
            }
            await serversDb.update({ _id: message.server.id }, { $set: { channel: channelId } }, { upsert: true });
        } else {
            await serversDb.update({ _id: message.server.id }, { $unset: { channel: true } });
            message.reply('канал сброшен.', true);
        }
        serversDb.persistence.compactDatafile();
    },

    info: async message => {
        const userId = Util.GetFirstUserMention(message.content);
        if(!userId)
            return;

        const user = await SafePromise(GetUser(userId));
        if(!user)
            return message.reply(UserNotExist(userId), true);

        const userInfo = await blacklistDb.findOne({ _id: user.id });
        SendMessage(message.channel_id, '', {
            description: UserTag(user),
            thumbnail: { url: user.avatar ? UserAvatar(user) : NoAvatar(user.discriminator) },
            fields: [
                userInfo ? { name: 'Пользователь находится в черном списке!', value: userInfo.reason } : { name: 'Пользователь не находится в черном списке.', value: ':thumbsup:' },
            ],
        });
    },

    blacklist: async message => {
        if(!IsModer(message.member))
            return;

        const bans = await GetBans(config.mainServer);
        let text = `**Черный список**\nВсего: ${await blacklistDb.count({})}\n\`\`\`cs\n`;
        for(let i = 0; i < bans.length; i++) {
            const
                banInfo = bans[i],
                userInfo = await blacklistDb.findOne({ _id: banInfo.user.id });

            if(!userInfo)
                continue;

            const add = `${banInfo.user.id} → ${Util.ReplaceApostrophe(banInfo.user.username)}#${banInfo.user.discriminator}\n`;
            if(text.length + add.length < 1990) {
                text += add;
            } else {
                message.reply(text + '\n```');
                text = '```cs\n' + add;
            }
        }
        message.reply(text + '\n```');
    },

    stats: async message => {
        if(!IsModer(message.member))
            return;

        message.reply(`**Статистика**\nПользователей в черном списке: ${await blacklistDb.count({})}\nПодключено серверов: ${ConnectedServers.size}`);
    },

    serverlist: async message => {
        if(!IsModer(message.member))
            return;

        const servers = [...ConnectedServers.values()];
        servers.sort((a, b) => (a.id > b.id) ? 1 : -1);

        let text = `**Список серверов**\nПодключено: ${ConnectedServers.size}\n\`\`\`css\n`;
        for(let i = 0; i < servers.length; i++) {
            const
                server = servers[i],
                serverInfo = await serversDb.findOne({ _id: server.id }),
                add = `${server.id} [${(serverInfo && serverInfo.trusted) ? 'T' : ' '}] ${server.name}\n`;

            if(text.length + add.length < 1990) {
                text += add;
            } else {
                message.reply(text + '\n```');
                text = '```css\n' + add;
            }
        }
        message.reply(text + '\n```');
    },

    link: async message => message.reply(`<https://discordapp.com/oauth2/authorize?client_id=${client.user.id}&permissions=${config.permissions}&scope=bot>`, true),

    help: async message => {
        let text = `**Справка**\n\n${headerHelp}\n\n${userHelp}\n\n`;

        if(IsModer(message.member))
            text += `${moderHelp}\n\n`;

        if(IsAdmin(message.member))
            text += `${adminHelp}\n\n`;

        if((message.server.id == config.mainServer) && IsAdmin(message.member))
            text += `${serviceHelp}\n\n`;

        message.reply(text);
    },

    invites: async message => {
        const invites = await SafePromise(GetServerInvites(message.server.id));
        if(!invites)
            return message.reply('команда не разрешена.', true);

        invites.sort((a, b) => b.uses - a.uses);
        const maxLen = (invites.length > 0) ? invites[0].uses.toString().length : 0;

        let text = `**Текущие инвайты**\nВсего: ${invites.length}\n\`\`\`py\n`;
        for(let i = 0; i < invites.length; i++) {
            const
                invite = invites[i],
                add = `${invite.code.padEnd(7)} | ${invite.uses.toString().padEnd(maxLen)} | ${invite.inviter.username}#${invite.inviter.discriminator}\n`;

            if(text.length + add.length < 1990) {
                text += add;
            } else {
                message.reply(text + '\n```');
                text = '```py\n' + add;
            }
        }
        message.reply(text + '\n```');
    },

    strict: async message => {
        if(!IsAdmin(message.member))
            return;

        const
            serverInfo = await serversDb.findOne({ _id: message.server.id }),
            strict = serverInfo ? !serverInfo.strict : true;

        await serversDb.update({ _id: message.server.id }, { $set: { strict } }, { upsert: true });
        serversDb.persistence.compactDatafile();
        message.server.strict = strict;

        message.reply(strict ? 'строгий режим включен. **Баны будут выдаваться без предупреждения.**' : 'строгий режим отключен.', true);
    },

    ban: async message => {
        if(!((message.server.id == config.mainServer) && IsAdmin(message.member)))
            return;

        const userId = Util.GetFirstUserMention(message.content);
        if(!userId)
            return;

        const user = await SafePromise(GetUser(userId));
        if(!user)
            return message.reply(UserNotExist(userId), true);

        if(user.id == client.user.id)
            return message.reply(':(', true);

        const reason = Util.RemoveMentions(message.content).trim();
        await blacklistDb.update({ _id: user.id }, { $set: { server: message.server.id, moder: message.author.id, date: Date.now(), reason: reason } }, { upsert: true });
        blacklistDb.persistence.compactDatafile();
        await TryBan(message.server, user, reason);

        message.reply(`пользователь ${UserToText(user)} добавлен в черный список.`, true);

        for(const server of ConnectedServers.values())
            if(server.id != message.server.id)
                await TryBan(server, user, reason);

        PushBlacklist();
    },

    unban: async message => {
        if(!((message.server.id == config.mainServer) && IsAdmin(message.member)))
            return;

        const userId = Util.GetFirstUserMention(message.content);
        if(!userId)
            return;

        const user = await SafePromise(GetUser(userId));
        if(!user)
            return message.reply(UserNotExist(userId), true);

        if(!(await blacklistDb.findOne({ _id: user.id })))
            return message.reply(`пользователь ${UserToText(user)} не находится в черном списке.`, true);

        await blacklistDb.remove({ _id: user.id });
        blacklistDb.persistence.compactDatafile();
        await TryUnban(message.server, user);

        message.reply(`пользователь ${UserToText(user)} удален из черного списка.`, true);

        for(const server of ConnectedServers.values())
            if(server.id != message.server.id)
                await TryUnban(server, user);

        PushBlacklist();
    },

    trust: async message => {
        if(!((message.server.id == config.mainServer) && IsAdmin(message.member)))
            return;

        const match = message.content.match(/[0-9]+/);
        if(!match)
            return;

        const
            serverId = match[0],
            server = ConnectedServers.get(serverId);

        if(!server)
            return message.reply(`сервер с идентификатором \`${serverId}\` не подключен.`, true);

        await serversDb.update({ _id: serverId }, { $set: { trusted: true } }, { upsert: true });
        serversDb.persistence.compactDatafile();
        server.trusted = true;
        message.reply(`сервер ${ServerToText(server)} добавлен в список доверенных.`, true);

        PushServerList();
    },

    untrust: async message => {
        if(!((message.server.id == config.mainServer) && IsAdmin(message.member)))
            return;

        const match = message.content.match(/[0-9]+/);
        if(!match)
            return;

        const
            serverId = match[0],
            server = ConnectedServers.get(serverId);

        if(!(await serversDb.findOne({ _id: serverId })))
            return message.reply('указанный сервер отсутствует в списке доверенных.', true);

        await serversDb.update({ _id: serverId }, { $unset: { trusted: true } });
        serversDb.persistence.compactDatafile();
        if(server) {
            server.trusted = false;
            message.reply(`сервер ${ServerToText(server)} удален из списка доверенных.`);
        } else {
            message.reply(`идентификатор \`${serverId}\` удален из списка доверенных.`);
        }

        PushServerList();
    },

    subscribe: async message => {
        if(!IsAdmin(message.member))
            return;

        const
            match = Util.GetNewsTags(message.content),
            tags = [];

        for(let i = 0; i < match.length; i++) {
            const
                tag = match[i].toLowerCase(),
                cat = await categoriesDb.findOne({ _id: tag });

            if(cat)
                tags.push(tag);
            else
                return message.reply(TagNotExist(tag), true);
        }

        const name = `Новости (${tags.length ? tags.join(', ') : 'все'})`;

        let webhook;
        try {
            webhook = await CreateWebhook(message.channel_id, name);
        } catch(e) {
            return message.reply(`не удалось создать вебхук.\n${e.code} ${e.message}`, true);
        }

        await hooksDb.insert({ _id: webhook.id, token: webhook.token, tags: (tags.length ? tags : undefined) });
        hooksDb.persistence.compactDatafile();
        message.reply(`в текущем канале создана подписка на \`${name}\`.`, true);
    },

    post: async message => {
        if(!((message.server.id == config.mainServer) && IsAdmin(message.member)))
            return;

        const jsonIndex = message.content.indexOf('{');
        if(jsonIndex < 0)
            return message.reply('в сообщении не найден JSON.', true);

        const obj = Util.ParseJSON(message.content.substring(jsonIndex));
        if(!obj)
            return message.reply('некорректный JSON.', true);

        try {
            await SendMessage(message.channel_id, obj.content || '', obj.embed);
        } catch(e) {
            return message.reply(`не удалось отправить проверочное сообщение.\n${e.code} ${e.message}`, true);
        }

        const match = Util.GetFirstNewsTag(message.content);
        if(!match)
            return;

        const
            tag = match.toLowerCase(),
            cat = await categoriesDb.findOne({ _id: tag });

        if(!cat)
            return message.reply(TagNotExist(tag), true);

        SendNews(tag, obj.content, obj.embed);
    },

    tags: async message => {
        if(!IsAdmin(message.member))
            return;

        const categories = await categoriesDb.find({});
        let text = '**Список категорий**\n\n';
        for(let i = 0; i < categories.length; i++) {
            const cat = categories[i];
            text += `\`${cat._id}\` - ${cat.name || client.user.username}\n`;
        }

        message.reply(text);
    },

    hooks: async message => {
        if(!((message.server.id == config.mainServer) && IsAdmin(message.member)))
            return;

        const hooks = await hooksDb.find({});
        let text = `**Активные подписки**\n\n`, changes = false;
        for(let i = 0; i < hooks.length; i++) {
            const
                hookInfo = hooks[i],
                hook = await SafePromise(GetWebhook(hookInfo._id, hookInfo.token));

            if(!hook) {
                await hooksDb.remove({ _id: hookInfo._id });
                changes = true;
                continue;
            }

            const
                server = ConnectedServers.get(hook.guild_id),
                add = `${server ? ServerToText(server) : hook.guild_id} | ${hookInfo.tags ? `[${hookInfo.tags.join(', ')}]` : 'все'}\n`;

            if(text.length + add.length < 1990) {
                text += add;
            } else {
                message.reply(text);
                text = add;
            }
        }

        changes && hooksDb.persistence.compactDatafile();
        message.reply(text);
    },

    addcat: async message => {
        if(!((message.server.id == config.mainServer) && IsAdmin(message.member)))
            return;

        const jsonIndex = message.content.indexOf('{');
        if(jsonIndex < 0)
            return message.reply('в сообщении не найден JSON.', true);

        const obj = Util.ParseJSON(message.content.substring(jsonIndex));
        if(!obj)
            return message.reply('некорректный JSON.', true);

        if(typeof obj.tag != 'string')
            return message.reply('необходимо указать тег категории.', true);

        const data = {};
        if(typeof obj.name == 'string')
            data.name = obj.name;

        if(typeof obj.avatar == 'string')
            data.avatar = obj.avatar;

        await categoriesDb.update({ _id: obj.tag }, { $set: data }, { upsert: true });
        categoriesDb.persistence.compactDatafile();

        message.reply(`категория \`${obj.tag}\` добавлена.`, true);
    },

    removecat: async message => {
        if(!((message.server.id == config.mainServer) && IsAdmin(message.member)))
            return;

        const match = Util.GetFirstNewsTag(message.content);
        if(!match)
            return message.reply('необходимо указать категорию для удаления.', true);

        const
            tag = match.toLowerCase(),
            cat = await categoriesDb.findOne({ _id: tag });

        if(!cat)
            return message.reply(TagNotExist(tag), true);

        await categoriesDb.remove({ _id: tag });
        categoriesDb.persistence.compactDatafile();

        message.reply(`категория \`${tag}\` удалена.`, true);
    },

    dumpcat: async message => {
        if(!((message.server.id == config.mainServer) && IsAdmin(message.member)))
            return;

        const match = Util.GetFirstNewsTag(message.content);
        if(!match)
            return message.reply('необходимо указать категорию .', true);

        const
            tag = match.toLowerCase(),
            cat = await categoriesDb.findOne({ _id: tag });

        if(!cat)
            return message.reply(TagNotExist(tag), true);

        const obj = { tag };
        if(cat.name)
            obj.name = cat.name;

        if(cat.avatar)
            obj.avatar = cat.avatar;

        message.reply(JSON.stringify(obj, null, 4));
    },
};

const CheckBanned = async member => {
    const userInfo = await blacklistDb.findOne({ _id: member.user.id });
    if(!userInfo)
        return false;

    if(await TryBan(member.server, member.user, userInfo.reason))
        Notify(member.server, `Пользователю ${UserToText(member.user)} из черного списка выдан автоматический бан!\n\`${userInfo.reason}\``);

    return true;
};

const CheckSpam = async message => {
    if(message.author.id == message.server.owner_id)
        return false;

    if(message.author.bot)
        return false;

    if(message.member.roles.length)
        return false;

    const codes = Util.GetInviteCodes(message.content);
    if(!codes.length)
        return false;

    let white = 0;
    for(let i = 0; i < codes.length; i++) {
        const invite = await SafePromise(GetInvite(codes[i]));
        if(!invite)
            break;

        if(invite.guild.id == message.server.id) {
            white++;
            continue;
        }

        const serverInfo = await serversDb.findOne({ _id: invite.guild.id });
        if(serverInfo && serverInfo.trusted) {
            white++;
            continue;
        }

        break;
    }

    if(white == codes.length)
        return false;

    const
        server = message.server,
        user = message.author;

    if(new Date(message.member.joined_at).getTime() < Date.now() - config.banJoinPeriod) {
        if(message.server.strict || SuspiciousUsers.has(user.id)) {
            TryDeleteMessage(message);
            clearTimeout(SuspiciousUsers.get(user.id));
            Notify(server, `Злоупотребление инвайтами от пользователя ${UserToText(user)}.\n\n${MessageContent(message.content)}`);
            SendPM(user, `**Предупреждение**\nОбнаружено злоупотребление инвайтами.`);
        } else {
            Notify(server, `Подозрительное сообщение от пользователя ${UserToText(user)}.\nСтрогий режим не включен, поэтому пока просто следим.\n\n${MessageUrl(message.server, message.channel_id, message)}`);
        }
        SuspiciousUsers.set(user.id, setTimeout(() => SuspiciousUsers.delete(user.id), config.suspiciousTimeout));
    } else {
        if(message.server.strict || SuspiciousUsers.has(user.id)) {
            const reason = '[Авто-бан] Спам инвайтов';
            await blacklistDb.insert({ _id: user.id, server: server.id, moder: client.user.id, date: Date.now(), reason });
            blacklistDb.persistence.compactDatafile();
            Notify(server, `Пользователь ${UserToText(user)} автоматически добавлен в черный список по причине спама.\n\n${MessageContent(message.content)}`);
            if(await TryBan(server, user, reason))
                SuspiciousUsers.delete(user.id);
            else
                TryDeleteMessage(message);

            await TryBan(config.mainServer, user, reason);
            PushBlacklist();
        } else {
            SuspiciousUsers.set(user.id, 1);
            Notify(server, `Сторонний пользователь ${UserToText(user)} разместил сторонний инвайт. Повторная попытка приведет к бану.\n\n${MessageContent(message.content)}`);
            TryDeleteMessage(message);
            SendPM(user, '**Предупреждение**\nВаши действия распознаны как спам. Повторная попытка приведет к бану.');
        }
    }

    return true;
};

const GenRolesMap = roles => {
    const map = new Map();
    for(let i = 0; i < roles.length; i++) {
        const role = roles[i];
        map.set(role.id, role);
    }
    return map;
};

const AddServer = async server => {
    const serverInfo = await serversDb.findOne({ _id: server.id });
    ConnectedServers.set(server.id, {
        id: server.id,
        name: server.name,
        roles: GenRolesMap(server.roles),
        member_count: server.member_count,
        icon: server.icon,
        owner_id: server.owner_id,
        trusted: serverInfo && serverInfo.trusted,
        strict: serverInfo && serverInfo.strict,
    });
};

const UpdateServer = (server, update) => {
    server.name = update.name;
    server.roles = GenRolesMap(update.roles);
    server.icon = update.icon;
    server.owner_id = update.owner_id;
};

const events = {
    READY: async data => {
        client.user = data.user;
        client.WsSend({ op: 3, d: { status: { web: 'online' }, game: { name: `${config.prefix}help`, type: 3 }, afk: false, since: 0 } });

        ConnectedServers.clear();

        const servers = data.guilds;
        for(let i = 0; i < servers.length; i++) {
            const server = servers[i];
            ConnectedServers.set(server.id, server);
        }

        console.log('READY');
    },

    MESSAGE_CREATE: async message => {
        if(!(message.content && message.guild_id && message.member))
            return;

        if(message.author.id == client.user.id)
            return;

        message.server = message.member.server = ConnectedServers.get(message.guild_id);
        message.member.user = message.author;
        message.reply = (content, mention) => SendMessage(message.channel_id, mention ? `${UserMention(message.author)}, ${content}` : content);

        if(await CheckBanned(message.member))
            return;

        if(await CheckSpam(message))
            return;

        if(message.content.substring(0, config.prefix.length).toLowerCase() != config.prefix)
            return;

        const
            si = message.content.search(/(\s|\n|$)/),
            command = message.content.substring(config.prefix.length, (si > 0) ? si : undefined).toLowerCase();

        if(!(command && botCommands.hasOwnProperty(command)))
            return;

        message.content = message.content.substring((si > 0) ? (si + 1) : '');
        botCommands[command](message);

        console.log(`COMMAND (${command}) SERVER (${message.server.id}) USER (${message.author.id})`);
    },

    GUILD_MEMBER_ADD: async member => {
        member.server = ConnectedServers.get(member.guild_id);
        member.server.member_count++;
        CheckBanned(member);
        PushServerList();
    },

    GUILD_MEMBER_REMOVE: async member => {
        const server = ConnectedServers.get(member.guild_id);
        if(!server)
            return;

        server.member_count--;
        PushServerList();
    },

    GUILD_CREATE: async server => {
        if(!server.name)
            return;

        !ConnectedServers.has(server.id) && ServiceLog(`**Подключен новый сервер!**\n${ServerToText(server)}\nВладелец: ${UserMention(server.owner_id)}`);
        AddServer(server);
        PushServerList();
    },

    GUILD_UPDATE: async update => {
        if(!update.name)
            return;

        const server = ConnectedServers.get(update.id);
        if(server) {
            if(server.name != update.name) {
                ServiceLog(`**Изменено название сервера** (${update.id})\n\`${server.name}\` → \`${update.name}\``);
            } else if(server.owner_id != update.owner_id) {
                ServiceLog(`**Изменен владелец сервера** (${update.id})\n${UserMention(server.owner_id)} → ${UserMention(update.owner_id)}`);
            }
            UpdateServer(server, update);
        } else {
            console.warn('Update event: server mismatch.');
            AddServer(update);
        }

        PushServerList();
    },

    GUILD_DELETE: async deleted => {
        if(deleted.unavailable)
            return;

        const server = ConnectedServers.get(deleted.id);
        if(!server)
            return;

        ConnectedServers.delete(deleted.id);
        ServiceLog(`**Сервер отключен**\n${ServerToText(server)}`);
        PushServerList();
    },

    GUILD_ROLE_CREATE: async data => {
        const server = ConnectedServers.get(data.guild_id);
        server && server.roles.set(data.role.id, data.role);
    },

    GUILD_ROLE_UPDATE: async data => {
        const server = ConnectedServers.get(data.guild_id);
        server && server.roles.set(data.role.id, data.role);
    },

    GUILD_ROLE_DELETE: async data => {
        const server = ConnectedServers.get(data.guild_id);
        server && server.roles.delete(data.role_id);
    },
};

client.on('packet', async packet => {
    const event = events[packet.t];
    event && event(packet.d);
});

client.Auth(process.env.TOKEN);
client.Connect(Discord.Intents.GUILDS | Discord.Intents.GUILD_MEMBERS | Discord.Intents.GUILD_MESSAGES);
