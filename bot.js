"use strict";

process.on('uncaughtException', console.error);
process.on('unhandledRejection', console.error);

function Shutdown(err) {
    console.error(err);
    process.exit(1);
}

if(!process.env.TOKEN)
    Shutdown('Необходим токен!');

const
    config = require('./config.json'),
    Util = require('./util.js'),
    Discord = require('discord.js'),
    Database = require('nedb-promise');

const client = new Discord.Client({
    messageCacheMaxSize: 1,
    disabledEvents: ['GUILD_ROLE_CREATE', 'GUILD_ROLE_DELETE', 'GUILD_ROLE_UPDATE', 'CHANNEL_UPDATE', 'CHANNEL_PINS_UPDATE', 'MESSAGE_DELETE', 'MESSAGE_UPDATE', 'MESSAGE_DELETE_BULK', 'USER_UPDATE', 'USER_NOTE_UPDATE', 'USER_SETTINGS_UPDATE', 'PRESENCE_UPDATE', 'VOICE_STATE_UPDATE', 'TYPING_START', 'VOICE_SERVER_UPDATE', 'RELATIONSHIP_ADD', 'RELATIONSHIP_REMOVE'],
});
client.on('disconnect', Shutdown);
client.on('error', console.warn);
client.on('reconnecting', console.log);
client.on('resume', console.log);
client.on('rateLimit', console.warn);

const
    blacklistDb = new Database({ filename: './storage/users.db', autoload: true }),
    serversDb = new Database({ filename: './storage/servers.db', autoload: true });

const
    RemoveMentions = str => str.replace(Discord.MessageMentions.USERS_PATTERN, ''),
    GetMentions = str => str.match(Discord.MessageMentions.USERS_PATTERN);

const helpText = `**Справка**

Префикс: **${config.prefix}**

Команды:
**channel** [#channel] - установка канала для информационных сообщений бота. Если канал не указан, параметр будет очищен.
**add** <@user> [reason] - добавить указанных пользователей в черный список с указанием причины.
**remove** <@user> - убрать указанных пользователей из черного списка.
**info** <@user> - показать информацию об указанных пользователях.
**cleanup** <count> - удалить указанное количество последних сообщений на канале. За один раз можно удалить максимум 100 сообщений.
**stats** - показать статистику.
**link** - показать ссылку на приглашение бота.
**help** - показать данное справочное сообщение.

Параметры:
<param> - обязательный параметр.
[param] - необязательный параметр.`;

const botCommands = {
    
    //Установка канала для информационных сообщений бота
    channel: async (message) => {
        if(!message.member.hasPermission(Discord.Permissions.FLAGS.MANAGE_CHANNELS))
            return;
        
        const
            channel = (message.mentions.channels && message.mentions.channels.size) ? message.mentions.channels.first() : null,
            info = await serversDb.findOne({ _id: message.guild.id });
        
        if(channel) {
            try {
                await channel.send('Проверка канала');
            } catch {
                message.reply('нет прав на размещение сообщений в указанном канале!');
                return;
            }
            
            if(info)
                await serversDb.update({ _id: message.guild.id }, { $set: { channel: channel.id } });
            else
                await serversDb.insert({ _id: message.guild.id, channel: channel.id });
            
            message.reply('канал установлен.');
        } else if(info) {
            await serversDb.update({ _id: message.guild.id }, { $unset: { channel: true } });
            message.reply('канал сброшен.');
        }
        
    },
    
    //Добавление в черный список
    add: async (message) => {
        if(!message.member.hasPermission(Discord.Permissions.FLAGS.BAN_MEMBERS))
            return;
        
        const info = await serversDb.findOne({ _id: message.guild.id });
        if(!(info && info.trusted)) {
            message.reply('данный сервер не может добавлять пользователей в черный список.');
            return;
        }
        
        if(!message.mentions.members)
            return;
        
        const
            reason = RemoveMentions(message.content).trim(),
            dt = Date.now();
        
        //Реализуем через ручной поиск упоминаний юзеров, так как пользователь может быть не на сервере.
        const mentions = GetMentions(message.content);
        if(!mentions)
            return;
        
        for(let i = 0; i < mentions.length; i++) {
            const match = mentions[i].match(/[0-9]+/);
            if(!match)
                continue;
            
            const usr = await client.fetchUser(match[0], false);
            if(!usr) {
                message.reply(`пользователь с идентификатором **${match[0]}** не существует.`);
                continue;
            }
            
            if(usr.id == client.user.id) {
                message.reply(':(');
                continue;
            }
            
            //Не трогаем админсостав
            let target;
            try {
                target = await message.guild.fetchMember(usr, false);
            } catch {}
            if(target && target.hasPermission(Discord.Permissions.FLAGS.MANAGE_MESSAGES)) {
                message.reply(`нельзя забанить пользователя ${target.toString()}, так как он является представителем администрации сервера.`);
                continue;
            }
            
            message.guild.ban(usr.id, { days: 1, reason: reason });
            
            const userInfo = await blacklistDb.findOne({ _id: usr.id });
            if(userInfo) {
                message.reply(`пользователь ${usr.toString()} уже находится в черном списке.`);
            } else {
                await blacklistDb.insert({ _id: usr.id, server: message.guild.id, moder: message.author.id, date: dt, reason: reason });
                const msg = `Модератор ${message.member.toString()} добавил пользователя ${usr.toString()} в черный список.${reason ? `\nПричина: ${reason}` : ''}`;
                SendInfo(message.guild, msg);
                ServiceLog(message.guild, msg);
                NotifyAllServers(message.guild.id, usr.id, true);
            }
        }
    },
    
    //Удаление из черного списка
    remove: async (message) => {
        if(!message.member.hasPermission(Discord.Permissions.FLAGS.BAN_MEMBERS))
            return;
        
        const info = await serversDb.findOne({ _id: message.guild.id });
        if(!(info && info.trusted)) {
            message.reply('данный сервер не может убирать пользователей из черного списка.');
            return;
        }
        
        //Реализуем через ручной поиск упоминаний юзеров, так как пользователь может быть не на сервере.
        const mentions = GetMentions(message.content);
        if(!mentions)
            return;
        
        const reason = RemoveMentions(message.content).trim();
        
        for(let i = 0; i < mentions.length; i++) {
            const match = mentions[i].match(/[0-9]+/);
            if(!match)
                continue;
            
            const
                id = match[0],
                userInfo = await blacklistDb.findOne({ _id: id });
            
            if(userInfo) {
                await blacklistDb.remove({ _id: id });
                try {
                    await message.guild.unban(id, reason);
                } catch {}
                const msg = `Модератор ${message.member.toString()} убрал пользователя <@${id}> из черного списка.${reason ? `\nПричина: ${reason}` : ''}`;
                SendInfo(message.guild, msg);
                ServiceLog(message.guild, msg);
                NotifyAllServers(message.guild.id, id, false);
            } else {
                message.reply(`пользователь <@${id}> не находится в черном списке.`);
            }
        }
    },
    
    //Выдача информации о состоянии пользователя
    info: async (message) => {
        //Предположительно пока даем получать информацию только модераторам
        if(!message.member.hasPermission(Discord.Permissions.FLAGS.MANAGE_MESSAGES))
            return;
        
        const mentions = GetMentions(message.content);
        if(!mentions)
            return;
        
        for(let i = 0; i < mentions.length; i++) {
            const match = mentions[i].match(/[0-9]+/);
            if(!match)
                continue;
            
            const
                id = match[0],
                userInfo = await blacklistDb.findOne({ _id: id }),
                server = client.guilds.get(userInfo.server);
            
            if(userInfo)
                message.channel.send(`**Информация**\nПользователь <@${id}> находится в черном списке.\nСервер: ${server ? `${server.name} (${server.id})` : userInfo.server} \nМодератор: <@${userInfo.moder}>\nДата добавления: ${Util.DtString(userInfo.date)}\nПричина: ${userInfo.reason}`);
            else
                message.channel.send(`**Информация**\nПользователь <@${id}> не находится в черном списке.`);
        }
    },
    
    //Удаление сообщений
    cleanup: async (message) => {
        if(!message.member.hasPermission(Discord.Permissions.FLAGS.MANAGE_MESSAGES))
            return;
        
        const count = parseInt(message.content);
        if(count && (count > 0))
            message.channel.bulkDelete(count);
    },
    
    //Выдача статистики
    stats: async (message) => {
        //Предположительно пока даем получать информацию только модераторам
        if(!message.member.hasPermission(Discord.Permissions.FLAGS.MANAGE_MESSAGES))
            return;
        
        const count = await blacklistDb.count({});
        message.channel.send(`**Статистика**\nПользователей в черном списке: ${count}\nПодключено серверов: ${client.guilds.size}`);
    },
    
    //Ссылка на приглашение бота
    link: async (message) => {
        message.reply(`<${await client.generateInvite(523334)}>`);
    },
    
    //Справка по боту
    help: async (message) => {
        //Предположительно пока даем получать информацию только модераторам
        if(!message.member.hasPermission(Discord.Permissions.FLAGS.MANAGE_MESSAGES))
            return;
        
        message.channel.send(helpText);
    },
    
    //Суперадминские команды, не показываем в справке, работают только в сервисном чате
    //Добавление доверенного сервера
    addserver: async (message) => {
        if(message.channel.id != config.serviceChannel)
            return;
        
        const server = client.guilds.get(message.content);
        if(!server) {
            message.reply('не удалось найти подключенный сервер с указанным идентификатором.');
            return;
        }
        
        const info = await serversDb.findOne({ _id: server.id });
        if(info) {
            if(info.trusted) {
                message.reply(`сервер **${server.name}** (${server.id}) уже находится в списке доверенных.`);
                return;
            }
            await serversDb.update({ _id: server.id }, { $set: { trusted: true } });
        } else {
            await serversDb.insert({ _id: server.id, trusted: true });
        }
        message.reply(`сервер **${server.name}** (${server.id}) добавлен в список доверенных.`);
    },
    
    //Удаление доверенного сервера
    removeserver: async (message) => {
        if(message.channel.id != config.serviceChannel)
            return;
        
        const info = await serversDb.findOne({ _id: message.content });
        if(!(info && info.trusted)) {
            message.reply(`сервер отсутствует в списке доверенных.`);
            return;
        }
        
        await serversDb.update({ _id: message.content }, { $unset: { trusted: true } });
        
        const server = client.guilds.get(message.content);
        if(server)
            message.reply(`сервер **${server.name}** (${server.id}) удален из списка доверенных.`);
        else
            message.reply(`сервер с идентификатором **${message.content}** удален из списка доверенных.`);
    },
    
    //Выдача списка всех подключенных серверов
    serverlist: async (message) => {
        if(message.channel.id != config.serviceChannel)
            return;
        
        let msg = `**Список серверов**\nВсего ${client.guilds.size}\n\`\`\`css\n`;
        for(const server of client.guilds.values()) {
            const info = await serversDb.findOne({ _id: server.id });
            msg += `[${(info && info.trusted) ? 'v' : ' '}] | ${server.id} | ${server.name}\n`;
        }
        msg += '```';
        
        message.channel.send(msg);
    },
    
    //Выдача списка всех пользователей в черном списке
    blacklist: async (message) => {
        if(message.channel.id != config.serviceChannel)
            return;
        
        const users = await blacklistDb.find({});
        
        let msg = `**Черный список**\nВсего ${users.length}\n\n`;
        for(let i = 0; i < users.length; i++)
            msg += `#${i + 1} <@${users[i]._id}>\n`;
        
        message.channel.send(msg);
    },
    
};

//Проверка пользователя в черном списке
async function CheckBanned(member) {
    //Не трогаем админсостав
    if(member.hasPermission(Discord.Permissions.FLAGS.MANAGE_MESSAGES))
        return false;
    
    const userInfo = await blacklistDb.findOne({ _id: member.id });
    if(!userInfo)
        return false;
    
    await member.ban({ days: 1, reason: 'Автоматический бан' });
    const msg = `Пользователь ${member.toString()} находится в черном списке! Выдан автоматический бан.`;
    SendInfo(member.guild, msg);
    ServiceLog(member.guild, msg);
    
    return true;
}

async function CheckSpam(message) {
    //Не трогаем админсостав
    if(message.member.hasPermission(Discord.Permissions.FLAGS.MANAGE_MESSAGES))
        return false;
    
    if(message.content.search(/discord\s*\.\s*gg/gim) > -1) {
        await blacklistDb.insert({ _id: message.author.id, server: message.guild.id, moder: client.user.id, date: Date.now(), reason: 'Автоматический бан по причине спама' });
        await message.member.ban({ days: 1, reason: 'Автоматический бан по причине спама' });
        const msg = `Пользователь ${message.member.toString()} автоматически добавлен в черный список по причине спама.\n\n**Содержимое сообщения**\n${message.content}`;
        SendInfo(message.guild, msg);
        ServiceLog(message.guild, msg);
        NotifyAllServers(message.guild.id, message.author.id, true);
        return true;
    }
    return false;
}

async function SendInfo(server, msg) {
    const info = await serversDb.findOne({ _id: server.id });
    if(info && info.channel)
        client.channels.get(info.channel).send(msg);
}

async function ServiceLog(srcServer, msg) {
    client.channels.get(config.serviceChannel).send(`**Сервер:** ${srcServer.name} (${srcServer.id})\n**Событие:**\n${msg}`);
}

async function NotifyServer(server, userId, mode) {
    if(mode) {
        let member;
        try {
            member = await server.fetchMember(userId, false);
        } catch {}
        if(member && member.hasPermission(Discord.Permissions.FLAGS.MANAGE_MESSAGES)) {
            SendInfo(server, `Попытка добавления в черный список представителя администрации ${member.toString()} на другом сервере. Рекомендуется срочно обратиться к администрации бота!`);
            ServiceLog(server, `Представитель администрации ${member.toString()} добавлен в черный список. Рекомендуется немедленно разобраться!`);
            return;
        }
        try {
            await server.ban(userId, { days: 1, reason: 'Автоматический бан' });
        } catch {}
        SendInfo(server, `Пользователь <@${userId}> был добавлен в черный список на другом сервере. Выдан автоматический бан.`);
    } else {
        try {
            await server.unban(userId);
        } catch {}
        SendInfo(server, `Пользователь <@${userId}> был убран из черного списка на другом сервере. Бан снят автоматически.`);
    }
}

async function NotifyAllServers(thisServerId, userId, mode) {
    for(const server of client.guilds.values())
        if(server.id != thisServerId)
            NotifyServer(server, userId, mode);
}

client.on('guildMemberAdd', CheckBanned);

client.on('guildCreate', async (server) => {
    client.channels.get(config.serviceChannel).send(`**Подключен новый сервер!**\n${server.name} (${server.id})`);
});
client.on('guildDelete', async (server) => {
    client.channels.get(config.serviceChannel).send(`**Сервер отключен**\n${server.name} (${server.id})`);
    serversDb.remove({ _id: server.id });
});

client.on('message', async (message) => {
    if(!(message.content && message.member))
        return;
    
    if(message.author.id == client.user.id)
        return;
    
    if((message.member.joinedTimestamp > Date.now() - config.banJoinPeriod) && (await CheckBanned(message.member) || await CheckSpam(message)))
        return;
    
    if(!message.content.startsWith(config.prefix))
        return;
    
    const
        si = message.content.indexOf(' '),
        command = botCommands[message.content.substring(config.prefix.length, (si > 0) ? si : undefined).toLowerCase()];
    
    if(command) {
        message.content = message.content.substring((si > 0) ? (si + 1) : '');
        command(message);
    }
});

client.on('ready', async () => {
    console.log('READY');
});

client.login(process.env.TOKEN);
