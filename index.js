require('dotenv').config();
// 環境変数の存在チェック
if (!process.env.DISCORD_TOKEN || !process.env.CLIENT_ID) {
  console.error('環境変数DISCORD_TOKENまたはCLIENT_IDが設定されていません！.envファイルまたはGitHub Secretsを確認してください。');
  process.exit(1);
}
const { Client, GatewayIntentBits, Collection, REST, Routes, EmbedBuilder, PermissionsBitField, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { db, addMedia, searchMediaByTags, getAllMedia, deleteMedia, getMyMedia, searchMediaByAuthor } = require('./database.js');

// Botクライアントの初期化
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

// スラッシュコマンドの定義
const commands = [
  {
    name: 'add',
    description: 'ゲームのスクリーンショットや動画をギャラリーに追加します',
  },
  {
    name: 'gallery',
    description: 'ギャラリーに保存されているメディアの一覧を表示します',
  },
  {
    name: 'delete',
    description: 'ギャラリーから指定したIDのメディアを削除します',
  },
  {
    name: 'help',
    description: 'ゲームギャラリーbotのコマンド一覧と使い方を表示します',
  }
];

// コマンドを登録
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('スラッシュコマンドの登録を開始...');
    
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands }
    );
    
    console.log('スラッシュコマンドの登録が完了しました');
  } catch (error) {
    console.error('コマンド登録エラー:', error);
  }
})();

// ギャラリーのページング状態を保存するマップ
const galleryStates = new Map();

// アーカイブチャンネルを取得または作成
async function getOrCreateArchiveChannel(guild) {
  // 既存のアーカイブチャンネルを探す
  let archiveChannel = guild.channels.cache.find(ch => ch.name === 'アーカイブ' && ch.isTextBased());
  
  if (!archiveChannel) {
    try {
      // サーバー作成者（オーナー）のみが閲覧できるチャンネルを作成
      const owner = await guild.fetchOwner();
      archiveChannel = await guild.channels.create({
        name: 'アーカイブ',
        type: 0, // テキストチャンネル
        permissionOverwrites: [
          {
            id: guild.id, // 全員
            deny: [PermissionsBitField.Flags.ViewChannel]
          },
          {
            id: owner.id, // サーバーオーナー
            allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory]
          },
          {
            id: client.user.id, // Bot自身
            allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.ManageMessages]
          }
        ]
      });
      console.log(`[${guild.name}] アーカイブチャンネルを作成しました`);
    } catch (error) {
      console.error(`[${guild.name}] アーカイブチャンネルの作成中にエラーが発生しました:`, error);
      return null;
    }
  }
  return archiveChannel;
}

// メッセージリンクまたは直接メディアURLからメディア情報を取得
async function fetchMediaFromLink(link, guild) {
  // Discordメッセージリンクの正規表現
  const messageLinkMatch = link.match(/https:\/\/discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)/);
  // 直接メディアURLの正規表現 (cdn.discordapp.comなど)
  const directMediaUrlMatch = link.match(/https:\/\/cdn\.discordapp\.com\/attachments\/\d+\/\d+\/[^/]+\.(png|jpg|jpeg|gif|mp4|mov|webm|webp)/i);

  if (messageLinkMatch) {
    const [, guildId, channelId, messageId] = messageLinkMatch;
    if (guildId !== guild.id) return null; // 異なるサーバーのメッセージリンクは無視

    try {
      const channel = await guild.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) return null;
      const message = await channel.messages.fetch(messageId);
      return { type: 'message', data: message };
    } catch (err) {
      console.error('メッセージの取得中にエラーが発生しました:', err);
      return null;
    }
  } else if (directMediaUrlMatch) {
    // 直接メディアURLの場合
    return { type: 'direct_url', data: { url: link } };
  } else {
    // どちらでもない場合
    return null;
  }
}

// クライアント起動時
client.on('clientReady', async () => {
  console.log(`ログイン完了: ${client.user.tag}`);
  
  // 起動時に参加している全サーバーでアーカイブチャンネルを確認・作成
  for (const guild of client.guilds.cache.values()) {
    await getOrCreateArchiveChannel(guild);
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand() && !interaction.isModalSubmit() && !interaction.isButton()) return;

  const { commandName, guild } = interaction;
  if (!guild) return;
  if (interaction.isChatInputCommand()) {
       if (commandName === 'add') {
       const modal = new ModalBuilder()
         .setCustomId('addMediaModal')
         .setTitle('ゲームギャラリーにメディアを追加');

        const messageLinkInput = new TextInputBuilder()
          .setCustomId('messageLinkInput')
          .setLabel('保存したいメッセージのリンク')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const tagsInput = new TextInputBuilder()
          .setCustomId('tagsInput')
          .setLabel('カンマ区切りでタグを指定（例：rpg, オープンワールド）')
          .setStyle(TextInputStyle.Short)
          .setRequired(false);

        const descriptionInput = new TextInputBuilder()
          .setCustomId('descriptionInput')
          .setLabel('メディアの説明')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false);

        const firstActionRow = new ActionRowBuilder().addComponents(messageLinkInput);
       const secondActionRow = new ActionRowBuilder().addComponents(tagsInput);
       const thirdActionRow = new ActionRowBuilder().addComponents(descriptionInput);

       modal.addComponents(firstActionRow, secondActionRow, thirdActionRow);

        await interaction.showModal(modal);
      } else if (commandName === 'gallery') {
      const modal = new ModalBuilder()
        .setCustomId('gallerySearchModal')
        .setTitle('ギャラリーを検索');

        const tagsInput = new TextInputBuilder()
          .setCustomId('tagsInput')
          .setLabel('フィルタリングするタグ（カンマ区切り、任意）')
          .setStyle(TextInputStyle.Short)
          .setRequired(false);

        const authorInput = new TextInputBuilder()
          .setCustomId('authorInput')
          .setLabel('検索する投稿者の名前（任意）')
          .setStyle(TextInputStyle.Short)
          .setRequired(false);

        const firstActionRow = new ActionRowBuilder().addComponents(tagsInput);
        const secondActionRow = new ActionRowBuilder().addComponents(authorInput);

        modal.addComponents(firstActionRow, secondActionRow);

        await interaction.showModal(modal);
      } else if (commandName === 'delete') {
      const modal = new ModalBuilder()
        .setCustomId('deleteMediaModal')
        .setTitle('メディアを削除');

        const mediaIdInput = new TextInputBuilder()
          .setCustomId('mediaIdInput')
          .setLabel('削除したいメディアのID（/galleryで確認可能）')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const firstActionRow = new ActionRowBuilder().addComponents(mediaIdInput);
        modal.addComponents(firstActionRow);
        await interaction.showModal(modal);
      } else if (commandName === 'help') {
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
      
      const helpEmbed = new EmbedBuilder()
          .setTitle('🎮 ゲームギャラリーbot 使い方')
          .setColor(0x5865F2)
          .setDescription('ゲームのスクショ・動画を保存・共有するBotです')
          .addFields(
            {
              name: '➕ /add',
              value: 'メディアを追加\n`<message_link>`（必須）保存したいメッセージのリンク\n`[tags]`（任意）カンマ区切りのタグ\n`[description]`（任意）メディアの説明\n※「アーカイブ」チャンネルにも保存されます'
            },
            {
              name: '🖼️ /gallery',
              value: 'メディア一覧を表示\n`[tags]`（任意）タグで絞り込み\n`[author]`（任意）投稿者名で検索\n✅ デフォルト：自分の投稿のみ表示\n✅ ボタンでページ送り可能（10件/ページ）'
            },
            {
              name: '🗑️ /delete',
              value: 'メディアを削除\n`<media_id>`（必須）削除したいID（/galleryで確認）\n✅ 本人またはサーバーオーナーのみ実行可\n※ギャラリーとアーカイブ両方から削除'
            },
            {
              name: '❓ /help',
              value: 'このヘルプを表示します'
            }
          )
          .setFooter({ text: 'メッセージリンクの取得方法：PCの場合→メッセージを右クリック→「メッセージリンクをコピー」｜スマホの場合→メッセージを長押し→「リンクをコピー」' });
        
        await interaction.editReply({ embeds: [helpEmbed] });
      }
    } else if (interaction.isModalSubmit()) {
    if (interaction.customId === 'addMediaModal') {
      await interaction.deferReply({ ephemeral: true });

      const messageLink = interaction.fields.getTextInputValue('messageLinkInput');
      const tags = interaction.fields.getTextInputValue('tagsInput').split(',').map(tag => tag.trim()).filter(tag => tag.length > 0);
      const description = interaction.fields.getTextInputValue('descriptionInput');

      const archiveChannel = await getOrCreateArchiveChannel(guild);
      if (!archiveChannel) {
        return interaction.editReply('アーカイブチャンネルの取得または作成に失敗しました。');
      }

      const mediaInfo = await fetchMediaFromLink(messageLink, guild);
      if (!mediaInfo) {
        return interaction.editReply('指定されたリンクが見つからないか、アクセスできません。リンクが正しいか、Botに適切な権限があるか確認してください。');
      }

      let mediaIdToSave = null;
      let channelIdToSave = null;
      let authorIdToSave = interaction.user.id; // コマンド実行者をデフォルトの投稿者とする
      let authorNameToSave = interaction.user.username;
      let archiveMessage;
      let mediaUrlForEmbed = null; // Embedに設定するメディアURL

      if (mediaInfo.type === 'message') {
        const fetchedMessage = mediaInfo.data;
        if (fetchedMessage.attachments.size === 0 && !fetchedMessage.content) {
          return interaction.editReply('添付ファイルまたはテキストコンテンツがないメッセージはギャラリーに追加できません。');
        }
        mediaIdToSave = fetchedMessage.id;
        channelIdToSave = fetchedMessage.channel.id;
        authorIdToSave = fetchedMessage.author.id;
        authorNameToSave = fetchedMessage.author.username;
        mediaUrlForEmbed = fetchedMessage.attachments.size > 0 ? fetchedMessage.attachments.first().url : null;

        try {
          const embed = new EmbedBuilder()
            .setTitle('ギャラリー追加メディア')
            .setDescription(description || '説明なし')
            .addFields(
              { name: '元メッセージ', value: messageLink },
              { name: '投稿者', value: authorNameToSave, inline: true },
              { name: 'タグ', value: tags.length > 0 ? tags.join(', ') : 'なし', inline: true }
            )
            .setTimestamp();

          if (mediaUrlForEmbed) {
            embed.setImage(mediaUrlForEmbed);
          }

          archiveMessage = await archiveChannel.send({
            content: `元メッセージ: ${messageLink}\n投稿者: ${authorNameToSave}\nタグ: ${tags.join(', ')}\n説明: ${description || 'なし'}`,
            embeds: [embed],
            files: fetchedMessage.attachments.map(attachment => attachment.url)
          });
        } catch (error) {
          console.error('アーカイブチャンネルへのメッセージ送信中にエラーが発生しました:', error);
          return interaction.editReply('メディアのアーカイブ中にエラーが発生しました。Botにアーカイブチャンネルへの送信権限があるか確認してください。');
        }
      } else if (mediaInfo.type === 'direct_url') {
        const directUrl = mediaInfo.data.url;
        mediaUrlForEmbed = directUrl;

        try {
          const embed = new EmbedBuilder()
            .setTitle('ギャラリー追加メディア')
            .setDescription(description || '説明なし')
            .addFields(
              { name: '元URL', value: directUrl },
              { name: '投稿者', value: authorNameToSave, inline: true },
              { name: 'タグ', value: tags.length > 0 ? tags.join(', ') : 'なし', inline: true }
            )
            .setTimestamp();

          embed.setImage(directUrl); // 直接URLを画像として設定

          archiveMessage = await archiveChannel.send({
            content: `元URL: ${directUrl}\n投稿者: ${authorNameToSave}\nタグ: ${tags.join(', ')}\n説明: ${description || 'なし'}`,
            embeds: [embed]
          });
        } catch (error) {
          console.error('アーカイブチャンネルへのメッセージ送信中にエラーが発生しました:', error);
          return interaction.editReply('メディアのアーカイブ中にエラーが発生しました。Botにアーカイブチャンネルへの送信権限があるか確認してください。');
        }
      }

      addMedia(
        guild.id,
        mediaIdToSave, // メッセージIDまたはNULL
        channelIdToSave, // チャンネルIDまたはNULL
        archiveMessage.id,
        authorIdToSave,
        authorNameToSave,
        description,
        tags,
        (err) => {
          if (err) {
            console.error('データベースへの追加中にエラーが発生しました:', err);
            return interaction.editReply('メディアの追加中にエラーが発生しました。');
          }
          interaction.editReply('メディアがギャラリーに追加されました！');
        }
      );
    } else if (interaction.customId === 'gallerySearchModal') {
      await interaction.deferReply();

      const tags = interaction.fields.getTextInputValue('tagsInput').split(',').map(tag => tag.trim()).filter(tag => tag.length > 0);
      const authorName = interaction.fields.getTextInputValue('authorInput').trim();

      let mediaItems = [];
      if (tags.length > 0) {
        mediaItems = await new Promise(resolve => searchMediaByTags(guild.id, tags, (_, rows) => resolve(rows)));
      } else if (authorName) {
        mediaItems = await new Promise(resolve => searchMediaByAuthor(guild.id, authorName, (_, rows) => resolve(rows)));
      } else {
        mediaItems = await new Promise(resolve => getMyMedia(guild.id, interaction.user.id, (_, rows) => resolve(rows)));
      }

      if (mediaItems.length === 0) {
        return interaction.editReply('条件に一致するメディアは見つかりませんでした。');
      }

      const itemsPerPage = 10;
      const totalPages = Math.ceil(mediaItems.length / itemsPerPage);

      galleryStates.set(interaction.user.id, {
        media: mediaItems,
        currentPage: 0,
        itemsPerPage: itemsPerPage,
        totalPages: totalPages
      });

      const getGalleryEmbed = (page) => {
        const start = page * itemsPerPage;
        const end = start + itemsPerPage;
        const currentItems = mediaItems.slice(start, end);

        const embed = new EmbedBuilder()
          .setTitle('ゲームギャラリー')
          .setDescription('保存されているゲームのスクリーンショットや動画です。')
          .setColor(0x00AE86)
          .setFooter({ text: `ページ ${page + 1}/${totalPages}` });

        currentItems.forEach(item => {
          embed.addFields({
            name: `ID: ${item.id} | 投稿者: ${item.author_name}`,
            value: `[元メッセージ](${item.message_link})\nタグ: ${item.tags || 'なし'}\n説明: ${item.description || 'なし'}`,
          });
        });
        return embed;
      };

      const getGalleryComponents = (page) => {
        const row = new ActionRowBuilder();
        row.addComponents(
          new ButtonBuilder()
            .setCustomId('prev_page')
            .setLabel('前へ')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(page === 0),
          new ButtonBuilder()
            .setCustomId('next_page')
            .setLabel('次へ')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(page === totalPages - 1)
        );
        return [row];
      };

      await interaction.editReply({
        embeds: [getGalleryEmbed(0)],
        components: getGalleryComponents(0)
      });
    } else if (interaction.customId === 'deleteMediaModal') {
      await interaction.deferReply({ ephemeral: true });

      const mediaId = interaction.fields.getTextInputValue('mediaIdInput');

      deleteMedia(guild.id, mediaId, async (err, mediaItem) => {
        if (err) {
          console.error('データベースからの削除中にエラーが発生しました:', err);
          return interaction.editReply('メディアの削除中にエラーが発生しました。');
        }
        if (!mediaItem) {
          return interaction.editReply('指定されたIDのメディアは見つかりませんでした。');
        }

        // サーバーオーナーまたは投稿者本人のみが削除可能
        if (interaction.user.id !== guild.ownerId && interaction.user.id !== mediaItem.author_id) {
          return interaction.editReply('このメディアを削除する権限がありません。サーバーオーナーまたは投稿者本人のみ削除できます。');
        }

        // アーカイブチャンネルからメッセージを削除
        try {
          const archiveChannel = await getOrCreateArchiveChannel(guild);
          if (archiveChannel && mediaItem.archive_message_id) {
            const archiveMessage = await archiveChannel.messages.fetch(mediaItem.archive_message_id);
            if (archiveMessage) {
              await archiveMessage.delete();
            }
          }
        } catch (archiveError) {
          console.warn('アーカイブメッセージの削除中にエラーが発生しました（既に削除されている可能性があります）:', archiveError);
        }

        interaction.editReply(`メディア (ID: ${mediaId}) がギャラリーから削除されました。`);
      });
    }
  } else if (interaction.isButton()) {
    if (galleryStates.has(interaction.user.id)) {
      const state = galleryStates.get(interaction.user.id);
      let newPage = state.currentPage;

      if (interaction.customId === 'prev_page') {
        newPage = Math.max(0, state.currentPage - 1);
      } else if (interaction.customId === 'next_page') {
        newPage = Math.min(state.totalPages - 1, state.currentPage + 1);
      }

      if (newPage !== state.currentPage) {
        state.currentPage = newPage;
        galleryStates.set(interaction.user.id, state);

        const getGalleryEmbed = (page) => {
          const start = page * state.itemsPerPage;
          const end = start + state.itemsPerPage;
          const currentItems = state.media.slice(start, end);

          const embed = new EmbedBuilder()
            .setTitle('ゲームギャラリー')
            .setDescription('保存されているゲームのスクリーンショットや動画です。')
            .setColor(0x00AE86)
            .setFooter({ text: `ページ ${page + 1}/${state.totalPages}` });

          currentItems.forEach(item => {
            embed.addFields({
              name: `ID: ${item.id} | 投稿者: ${item.author_name}`,
              value: `[元メッセージ](${item.message_link})\nタグ: ${item.tags || 'なし'}\n説明: ${item.description || 'なし'}`,
            });
          });
          return embed;
        };

        const getGalleryComponents = (page) => {
          const row = new ActionRowBuilder();
          row.addComponents(
            new ButtonBuilder()
              .setCustomId('prev_page')
              .setLabel('前へ')
              .setStyle(ButtonStyle.Primary)
              .setDisabled(page === 0),
            new ButtonBuilder()
              .setCustomId('next_page')
              .setLabel('次へ')
              .setStyle(ButtonStyle.Primary)
              .setDisabled(page === state.totalPages - 1)
          );
          return [row];
        };

        await interaction.update({
          embeds: [getGalleryEmbed(newPage)],
          components: getGalleryComponents(newPage)
        });
      } else {
        await interaction.deferUpdate();
      }
    }
  }
});

// Botログイン
client.login(process.env.DISCORD_TOKEN);