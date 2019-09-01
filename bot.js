'use strict';

process.on('uncaughtException', console.error);
process.on('unhandledRejection', console.error);

const Shutdown = err => {
    console.error(err);
    process.exit(1);
};

if(!process.env.TOKEN)
    Shutdown('Token required.');

const storagePath = process.env.STORAGE;
if(!storagePath)
    Shutdown('Storage path required.');

if(global.gc)
    setInterval(global.gc, 3600000);

const
    Database = require('nedb-promise'),
    Discord = require('discord.js'),
    Util = require('./util.js'),
    config = require('./config.json'),
    fs = require('fs');

const
    blacklistDb = new Database({ filename: `${storagePath}/blacklist.db`, autoload: true }),
    serversDb = new Database({ filename: `${storagePath}/servers.db`, autoload: true }),
    categoriesDb = new Database({ filename: `${storagePath}/categories.db`, autoload: true }),
    hooksDb = new Database({ filename: `${storagePath}/hooks.db`, autoload: true });

const client = new Discord.Client({
    disabledEvents: (() => {
        const events = [];
        for(const event in Discord.Constants.WSEvents)
            events.push(event);
        return events;
    })(),
});

const StatusTracker = require('http').createServer((_, res) => res.end('ONLINE'));
client.on('reconnecting', () => {
    StatusTracker.close();
    console.warn('Reconnect');
});

client.on('disconnect', Shutdown);
client.on('error', () => console.error('Connection error!'));
client.on('resume', () => console.warn('Connection resume'));
client.on('rateLimit', () => console.warn('Rate limit!'));

const
    Endpoints = Discord.Constants.Endpoints,
    FLAGS = Discord.Permissions.FLAGS,
    CDN = Discord.Constants.DefaultOptions.http.cdn,
    ConnectedServers = new Map(),
    SuspiciousUsers = new Map(),
    SafePromise = promise => new Promise(resolve => promise.then(result => resolve(result)).catch(() => resolve(null)));

const
    BanUser = (server, user, reason) => client.rest.makeRequest('put', `${Endpoints.Guild(server).bans}/${user.id||user}?delete-message-days=1&reason=${reason}`, true),
    CreateWebhook = (channel, name, avatar) => client.rest.makeRequest('post', Endpoints.Channel(channel).webhooks, true, { name, avatar }),
    DeleteMessage = message => client.rest.makeRequest('delete', Endpoints.Channel(message.channel_id).Message(message), true),
    GetBans = server => client.rest.makeRequest('get', Endpoints.Guild(server).bans, true),
    GetInvite = code => client.rest.makeRequest('get', Endpoints.Invite(code), true),
    GetUser = userId => client.rest.makeRequest('get', Endpoints.User(userId), true),
    GetUserChannel = user => client.rest.makeRequest('post', Endpoints.User(client.user).channels, true, { recipient_id: user.id || user }),
    GetWebhook = (id, token) => client.rest.makeRequest('get', Endpoints.Webhook(id, token)),
    SendMessage = (channel, content, embed) => client.rest.makeRequest('post', Endpoints.Channel(channel).messages, true, { content, embed }),
    SendWebhookMessage = (id, token, username, avatar_url, content, embed) => client.rest.makeRequest('post', Endpoints.Webhook(id, token), false, { username, avatar_url, content, embeds: embed ? [embed] : undefined }),
    UnbanUser = (server, user) => client.rest.makeRequest('delete', `${Endpoints.Guild(server).bans}/${user.id||user}`, true);

const
    CheckPermission = (permissions, flag) => ((permissions & FLAGS.ADMINISTRATOR) > 0) || ((permissions & flag) === flag),
    MessageContent = str => `**Содержимое сообщения**\`\`\`${str}\`\`\``,
    MessageUrl = (server, channel, message) => `${Discord.Constants.DefaultOptions.http.host}/channels/${server.id||server}/${channel.id||channel}/${message.id||message}`,
    NoAvatar = discriminator => `${CDN}/embed/avatars/${parseInt(discriminator)%5}.png`,
    ServerToText = server => `\`${server.name}\` (${server.id})`,
    TagNotExist = tag => `тег \`${tag}\` не существует.`,
    UserAvatar = user => `${CDN}/avatars/${user.id}/${user.avatar}`,
    UserMention = user => `<@${user.id || user}>`,
    UserNotExist = id => `пользователь с идентификатором \`${id}\` не существует.`,
    UserTag = user => `**${user.username}**\`#${user.discriminator}\``,
    UserToText = user => `${UserMention(user)} (\`${UserTag(user)}\`)`;

const HasPermission = async (member, flag) => {
    const serverRoles = new Map();
    let roles = member.server.roles;
    for(let i = 0; i < roles.length; i++) {
        const role = roles[i];
        serverRoles.set(role.id, role);
    }
    
    roles = member.roles;
    for(let i = 0; i < roles.length; i++) {
        const role = serverRoles.get(roles[i]);
        if(role && CheckPermission(role.permissions, flag))
            return true;
    }
    
    return false;
};

const
    IsAdmin = member => HasPermission(member, Discord.Permissions.FLAGS.MANAGE_CHANNELS),
    IsModer = member => HasPermission(member, Discord.Permissions.FLAGS.MANAGE_MESSAGES),
    ServiceLog = msg => SendMessage(config.serviceChannel, msg);

const TryBan = async (server, user, reason) => {
    if(await SafePromise(BanUser(server, user, reason)))
        return true;
    
    Notify(server, `Не удалось забанить пользователя ${UserToText(user)}!`);
    return false;
};

const TryUnban = async (server, user) => {
    if(await SafePromise(UnbanUser(server, user)))
        return true;
    
    Notify(server, `Не удалось разбанить пользователя ${UserToText(user)}!`);
};

const SendInfo = async (server, msg) => {
    const serverInfo = await serversDb.findOne({ _id: server.id });
    if(!(serverInfo && serverInfo.channel))
        return;
    
    if(!(await SafePromise(SendMessage(serverInfo.channel, msg))))
        ServiceLog(`На сервере ${ServerToText(server)} не удалось отправить сообщение в сервисный канал!`);
};

const Notify = (server, msg) => {
    ServiceLog(`**Сервер:** ${ServerToText(server)}\n**Событие:**\n${msg}`);
    SendInfo(server, msg);
};

const TryDeleteMessage = async message => {
    if(!(await SafePromise(DeleteMessage(message))))
        Notify(message.server, `**Не удалось удалить сообщение!**\n${MessageUrl(message.server, message.channel_id, message)}`);
};

const SendPM = async (user, msg) => {
    const channel = await SafePromise(GetUserChannel(user));
    if(channel)
        SafePromise(SendMessage(channel, msg))
};

const SendNews = async (tag, content, embed) => {
    const
        channels = new Set(),
        hooks = await hooksDb.find({});
    
    hooks.forEach(async hookInfo => {
        const hook = await GetWebhook(hookInfo._id, hookInfo.token);
        if(!hook)
            return await hooksDb.remove({ _id: hookInfo._id });
        
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
    
    const output = [];
    for(const server of ConnectedServers.values()) {
        const serverInfo = await serversDb.findOne({ _id: server.id });
        output.push({
            id: server.id,
            name: server.name,
            users: server.member_count,
            image: server.icon,
            trusted: serverInfo ? serverInfo.trusted : false,
        });
    }
    
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

const
    headerHelp = `**Информационная панель бота**
${config.panelUrl}`,
    
    userHelp = `**Команды пользователя**
\`link\` - показать ссылку на приглашение бота.
\`info @user\` - показать информацию об указанном пользователе.
\`help\` - показать данное справочное сообщение.`,
    
    moderHelp = `**Команды модератора**
\`cleanup N\` - удалить N последних сообщений на канале. Максимум 100 сообщений.
\`stats\` - показать количество серверов и банов.
\`blacklist\` - показать список всех пользователей в черном списке.
\`serverlist\` - показать список всех подключенных серверов.`,
    
    adminHelp = `**Команды администратора**
\`channel #канал\` - установка канала для информационных сообщений бота. Если канал не указан, параметр будет очищен.
\`subscribe $tag\` - подписаться на категории с указанными тегами. Если теги не указаны, будет осуществлена подписка на все категории.
\`tags\` - показать список всех доступных новостных категорий.`,
    
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
            if(await SafePromise(SendMessage(channelId, 'Канал установлен.')))
                await serversDb.update({ _id: message.server.id }, { $set: { channel: channelId } }, { upsert: true });
            else
                message.reply('нет доступа к указанному каналу!', true);
        } else {
            await serversDb.update({ _id: message.server.id }, { $unset: { channel: true } });
            message.reply('канал сброшен.', true);
        }
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
    
    cleanup: async message => {
        if(!IsModer(message.member))
            return;
        
        const limit = parseInt(message.content);
        if(!(limit && (limit > 0)))
            return;
        
        const messages = (await client.rest.makeRequest('get', `${Endpoints.Channel(message.channel_id).messages}?limit=${Math.min(limit, 100)}`, true)).map(m => m.id);
        client.rest.makeRequest('post', Endpoints.Channel(message.channel_id).messages.bulkDelete, true, { messages });
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
        await TryBan(message.server, user, reason);
        
        message.reply(`пользователь ${UserToText(user)} добавлен в черный список.`, true);
        
        for(const server of ConnectedServers.values())
            if(server.id != message.server.id)
                TryBan(server, user, reason);
        
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
        await TryUnban(message.server, user);
        
        message.reply(`пользователь ${UserToText(user)} удален из черного списка.`, true);
        
        for(const server of ConnectedServers.values())
            if(server.id != message.server.id)
                TryUnban(server, user);
        
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
        message.reply(`${server ? `сервер ${ServerToText(server)}` : `идентификатор \`${serverId}\``} удален из списка доверенных.`);
        
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
        
        const
            name = `Новости (${tags.length ? tags.join(', ') : 'все'})`,
            webhook = await SafePromise(CreateWebhook(message.channel, name));
        
        if(!webhook)
            return message.reply('не удалось создать вебхук.', true);
        
        await hooksDb.insert({ _id: webhook.id, token: webhook.token, tags: (tags.length ? tags : undefined) });
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
        
        if(!(await SafePromise(SendMessage(message.channel_id, obj.content || '', obj.embed))))
            return message.reply('не удалось отправить проверочное сообщение.', true);
        
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
        let text = `**Активные подписки**\n\n`;
        for(let i = 0; i < hooks.length; i++) {
            const
                hookInfo = hooks[i],
                hook = await SafePromise(GetWebhook(hookInfo._id, hookInfo.token));
            
            if(!hook) {
                await hooksDb.remove({ _id: hookInfo._id });
                continue;
            }
            
            const
                server = ConnectedServers.get(hook.guild_id),
                add = `${server ? ServerToText(server) : hook.guild_id} | ${hookInfo.tags ? `[${hookInfo.tags.join(', ')}]` : 'все' }\n`;
            
            if(text.length + add.length < 1990) {
                text += add;
            } else {
                message.reply(text);
                text = add;
            }
        }
        
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
        
        if(typeof(obj.tag) != 'string')
            return message.reply('необходимо указать тег категории.', true);
        
        const data = {};
        if(typeof(obj.name) == 'string')
            data.name = obj.name;
        
        if(typeof(obj.avatar) == 'string')
            data.avatar = obj.avatar;
        
        await categoriesDb.update({ _id: obj.tag }, { $set: data }, { upsert: true });
        
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
        if(SuspiciousUsers.has(user.id)) {
            Notify(server, `Злоупотребление инвайтами от пользователя ${UserToText(user)}.\n\n${MessageContent(message.content)}`);
            clearTimeout(SuspiciousUsers.get(user.id));
            TryDeleteMessage(message);
            SendPM(user, `Обнаружено злоупотребление инвайтами.`);
        }
        SuspiciousUsers.set(user.id, setTimeout(() => SuspiciousUsers.delete(user.id), config.suspiciousTimeout));
    } else {
        if(SuspiciousUsers.has(user.id)) {
            await blacklistDb.insert({ _id: user.id, server: server.id, moder: client.user.id, date: Date.now(), reason: 'Автоматически: сторонний пользователь, спам сторонним инвайтом' });
            Notify(server, `Пользователь ${UserToText(user)} автоматически добавлен в черный список по причине спама.\n\n${MessageContent(message.content)}`);
            if(await TryBan(server, user, 'Автоматический бан'))
                SuspiciousUsers.delete(user.id);
            else
                TryDeleteMessage(message);
            
            await TryBan(config.mainServer, user, 'Автоматический бан');
            PushBlacklist();
        } else {
            SuspiciousUsers.set(user.id, 0);
            Notify(server, `Сторонний пользователь ${UserToText(user)} разместил стороннее приглашение. Повторная попытка приведет к бану.\n\n${MessageContent(message.content)}`);
            TryDeleteMessage(message);
            SendPM(user, `Обнаружена попытка спама на сервере ${ServerToText(server)}. Повторная попытка спама приведет к бану.`);
        }
    }
    
    return true;
};

const events = {
    READY: async data => {
        console.log('INIT');
        
        ConnectedServers.clear();
        
        client.user = data.user;
        client.ws.send({ op: 3, d: { status: { web: 'online' }, game: { name: `${config.prefix}help`, type: 3 }, afk: false, since: 0 } });
        
        const ClientReady = () => {
            if(!StatusTracker.listening)
                StatusTracker.listen(21240);
            
            PushBlacklist();
            PushServerList();
            
            client.setInterval(() => {
                PushBlacklist();
            }, 3600000);
            
            console.log('READY');
        };
        
        const
            serverCount = data.guilds.length,
            origFunc = events.GUILD_CREATE;
        
        let connected = 0;
        events.GUILD_CREATE = async server => {
            server.members = null;
            server.presences = null;
            ConnectedServers.set(server.id, server);
            connected++;
            
            if(connected < serverCount)
                return;
            
            events.GUILD_CREATE = origFunc;
            ClientReady();
        };
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
        
        if(!message.content.startsWith(config.prefix))
            return;
        
        const
            si = message.content.search(/(\s|\n|$)/),
            command = botCommands[message.content.substring(config.prefix.length, (si > 0) ? si : undefined).toLowerCase()];
        
        if(!command)
            return;
        
        message.content = message.content.substring((si > 0) ? (si + 1) : '');
        
        command(message);
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
        events.GUILD_UPDATE(server);
        ServiceLog(`**Подключен новый сервер!**\n${ServerToText(server)}\nВладелец: ${UserToText(await GetUser(server.owner_id))}`);
    },
    
    GUILD_UPDATE: async server => {
        server.members = null;
        server.presences = null;
        ConnectedServers.set(server.id, server);
        PushServerList();
    },
    
    GUILD_DELETE: async server => {
        ConnectedServers.delete(server.id);
        ServiceLog(`**Сервер отключен**\n${ServerToText(server)}`);
        PushServerList();
    },
};

client.on('raw', async packet => {
    const event = events[packet.t];
    if(event)
        event(packet.d);
});

client.manager.connectToWebSocket(process.env.TOKEN, () => {}, () => {});
