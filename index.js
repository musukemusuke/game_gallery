require('dotenv').config();
// 環境変数の存在チェック
if (!process.env.DISCORD_TOKEN || !process.env.CLIENT_ID) {
  console.error('環境変数DISCORD_TOKENまたはCLIENT_IDが設定されていません！.envファイルまたはGitHub Secretsを確認してください。');
  process.exit(1);
}
const { Client, GatewayIntentBits, Collection, REST, Routes, EmbedBuilder, PermissionsBitField, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
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
    options: [
      {
        type: 3,
        name: 'message_link',
        description: '保存したいメッセージのリンク',
        required: true,
      },
      {
        type: 3,
        name: 'tags',
        description: 'カンマ区切りでタグを指定（例：rpg, オープンワールド, steam）',
        required: false,
      },
      {
        type: 3,
        name: 'description',
        description: 'メディアの説明',
        required: false,
      }
    ]
  },
  {
    name: 'gallery',
    description: 'ギャラリーに保存されているメディアの一覧を表示します',
    options: [
      {
        type: 3,
        name: 'tags',
        description: 'フィルタリングするタグ（カンマ区切り、任意）',
        required: false,
      },
      {
        type: 3,
        name: 'author',
        description: '検索する投稿者の名前（任意）',
        required: false,
      }
    ]
  },
  {
    name: 'delete',
    description: 'ギャラリーから指定したIDのメディアを削除します',
    options: [
      {
        type: 4,
        name: 'media_id',
        description: '削除したいメディアのID（/galleryで確認可能）',
        required: true,
      }
    ]
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
    } catch (err) {
      // 権限不足でチャンネル作成できない場合のエラーハンドリング
      console.error('アーカイブチャンネルの作成に失敗:', err);
      return null;
    }
  }
  return archiveChannel;
}

// メッセージリンクからメッセージを取得
async function fetchMessageFromLink(link, guild) {
  try {
    const match = link.match(/channels\/(\d+)\/(\d+)\/(\d+)/);
    if (!match) return null;
    
    const [, guildId, channelId, messageId] = match;
    if (guildId !== guild.id) return null;
    
    const channel = await guild.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) return null;
    
    return await channel.messages.fetch(messageId);
  } catch (err) {
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

// 新しくサーバーに参加した時
client.on('guildCreate', async (guild) => {
  console.log(`新しいサーバーに参加しました: ${guild.name}`);
  await getOrCreateArchiveChannel(guild);
});

// インタラクション処理
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  
  const { commandName, guild } = interaction;
  if (!guild) return;
  
  // コマンド実行者がサーバーオーナーか確認
  const owner = await guild.fetchOwner();
  if (interaction.user.id !== owner.id) {
    return interaction.reply({
      content: 'このコマンドはサーバーオーナーのみが使用できます。',
      flags: [MessageFlags.Ephemeral]
    });
  }
  
  if (commandName === 'add') {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    
    try {
      const messageLink = interaction.options.getString('message_link');
      const tagsStr = interaction.options.getString('tags');
      const description = interaction.options.getString('description') || '';
      const tags = tagsStr ? tagsStr.split(',').map(t => t.trim()).filter(t => t) : [];
      
      // 画像直接URLかメッセージリンクかを判定
      const imageUrlMatch = messageLink.match(/^https:\/\/cdn\.discordapp\.com\/attachments\//);
      let targetAttachments = [];
      let authorId = interaction.user.id;
      let authorName = interaction.user.username;
      
      if (imageUrlMatch) {
        // 直接画像URLが渡された場合
        targetAttachments = [{ url: messageLink }];
      } else {
        // 通常のメッセージリンクの場合
        const targetMessage = await fetchMessageFromLink(messageLink, guild);
        if (!targetMessage) {
          return interaction.editReply('メッセージが見つかりませんでした。リンクが正しいか確認してください。');
        }
        
        const hasAttachments = targetMessage.attachments.size > 0;
        if (!hasAttachments) {
          return interaction.editReply('指定されたメッセージに画像や動画の添付ファイルが含まれていません。');
        }
        
        targetAttachments = Array.from(targetMessage.attachments.values());
        authorId = targetMessage.author.id;
        authorName = targetMessage.author.username;
      }
      
      // archiveチャンネルを取得
      const archiveChannel = await getOrCreateArchiveChannel(guild);
      if (!archiveChannel) {
        return interaction.editReply('⚠️ アーカイブチャンネルの作成に失敗しました。サーバー管理者に以下を依頼してください：\n1. Botに「チャンネルを管理する」権限を付与する\n2. または手動で「アーカイブ」という名前のテキストチャンネルを作成する');
      }
      
      // アーカイブチャンネルに転記
      const galleryEmbed = new EmbedBuilder()
        .setTitle('🎮 ゲームギャラリーに追加')
        .setDescription(description || '説明なし')
        .addFields(
          { name: '投稿者', value: `<@${authorId}>`, inline: true },
          { name: '元のリンク', value: `[リンク](${messageLink})`, inline: true }
        )
        .setTimestamp()
        .setColor(0x5865F2);
      
      if (tags.length > 0) {
        galleryEmbed.addFields({ name: 'タグ', value: tags.map(t => `#${t}`).join(' ') });
      }
      
      // 最初の添付ファイルを埋め込み
      if (targetAttachments[0] && targetAttachments[0].url) {
        galleryEmbed.setImage(targetAttachments[0].url);
      }
      
      // 全ての添付ファイルのURLを追加
      let attachmentsText = targetAttachments.map(a => a.url).join('\n');
      const sentMessage = await archiveChannel.send({
        embeds: [galleryEmbed],
        content: `添付ファイル一覧:\n${attachmentsText}`
      });
      
      // データベースに登録
      addMedia(
        guild.id,
        sentMessage.id,
        archiveChannel.id,
        sentMessage.id,
        interaction.user.id,
        interaction.user.username,
        description,
        tags,
        (err, mediaId) => {
          if (err) {
            console.error('データベース登録エラー:', err);
            return interaction.editReply('データベースへの追加中にエラーが発生しました。');
          }
          interaction.editReply(`✅ ゲームギャラリーに追加しました！\nID: ${mediaId}\n#${tags.join(' #')}`);
        }
      );
      
    } catch (error) {
      console.error('addコマンドエラー:', error);
      interaction.editReply('コマンドの実行中にエラーが発生しました。');
    }
  }
  
  if (commandName === 'gallery') {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    
    try {
      const tagsStr = interaction.options.getString('tags');
      const authorStr = interaction.options.getString('author');
      const searchTags = tagsStr ? tagsStr.split(',').map(t => t.trim().toLowerCase()).filter(t => t) : [];
      
      let results;
      if (authorStr) {
        results = await new Promise((resolve, reject) => {
          searchMediaByAuthor(guild.id, authorStr, (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
          });
        });
      } else if (searchTags.length > 0) {
        results = await new Promise((resolve, reject) => {
          searchMediaByTags(guild.id, searchTags, (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
          });
        });
      } else {
        results = await new Promise((resolve, reject) => {
          getMyMedia(guild.id, interaction.user.id, (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
          });
        });
      }
      
      if (!results || results.length === 0) {
        return interaction.editReply('ゲームギャラリーに保存されたメディアが見つかりませんでした。');
      }
      
      // 最初の1件を画像付きで表示（ページング対応）
      const currentPage = 0;
      const item = results[currentPage];
      // キャッシュにない場合もfetchで取得するように修正
      let channel = null;
      try {
        channel = await guild.channels.fetch(item.channel_id);
      } catch (err) {
        console.log('アーカイブチャンネルの取得に失敗:', err);
      }
      const jumpUrl = channel ? `https://discord.com/channels/${guild.id}/${item.channel_id}/${item.message_id}` : 'リンク無効';
      
      // JSTで日付をフォーマット
      const jstDate = new Date(item.timestamp);
      jstDate.setHours(jstDate.getHours() + 9); // UTCからJSTに変換
      const formattedDate = jstDate.toLocaleDateString('ja-JP');
      
      // アーカイブメッセージから画像URLを取得、失敗してもitemにmessage_urlがあればそれを使う
      let imageUrl = null;
      if (channel) {
        try {
          const archiveMessage = await channel.messages.fetch(item.message_id);
          if (archiveMessage.embeds.length > 0 && archiveMessage.embeds[0].image) {
            imageUrl = archiveMessage.embeds[0].image.url;
          }
        } catch (err) {
          console.log('アーカイブメッセージの取得に失敗、元のURLを使用します:', err);
        }
      }
      // アーカイブから取得できなかった場合、itemに保存されているURLを直接使用
      if (!imageUrl && item.message_url) {
        imageUrl = item.message_url;
      }
      
      let title = `🎮 ゲームギャラリー (${currentPage + 1}/${results.length})`;
      if (authorStr) {
        title = `🎮 投稿者検索結果: 「${authorStr}」さんの投稿 (${currentPage + 1}/${results.length})`;
      } else if (searchTags.length > 0) {
        title = `🎮 タグ検索結果: #${searchTags.join(' #')} (${currentPage + 1}/${results.length})`;
      } else {
        title = `🎮 あなたの投稿 (${currentPage + 1}/${results.length})`;
      }
      
      const embed = new EmbedBuilder()
        .setTitle(title)
        .setColor(0x57F287)
        .addFields(
          { name: 'ID', value: String(item.id), inline: true },
          { name: '投稿日', value: formattedDate, inline: true },
          { name: '投稿者', value: item.author_name, inline: true },
          { name: 'タグ', value: item.tags ? item.tags.split(',').map(t => `#${t}`).join(' ') : 'なし' },
          { name: '説明', value: item.description || '説明なし' }
        )
        .setTimestamp();
      
      if (imageUrl) {
        embed.setImage(imageUrl);
      }
      
      // ページ送りボタンを作成
      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId('prev_page')
            .setLabel('◀ 前へ')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(currentPage === 0),
          new ButtonBuilder()
            .setCustomId('next_page')
            .setLabel('次へ ▶')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(currentPage === results.length - 1)
        );
      
      // ギャラリーの状態を保存（ユーザーIDとメッセージIDで識別）
      const stateId = `${interaction.user.id}-${interaction.id}`;
      galleryStates.set(stateId, {
        results,
        currentPage,
        guildId: guild.id,
        searchTags,
        authorStr
      });
      
      await interaction.editReply({ embeds: [embed], components: [row] });
      
      // ボタンのインタラクションを処理するリスナーを一時的に設定
      const filter = i => i.user.id === interaction.user.id && (i.customId === 'prev_page' || i.customId === 'next_page');
      const collector = interaction.channel.createMessageComponentCollector({ filter, time: 60000 }); // 60秒間有効
      
      collector.on('collect', async i => {
        const state = galleryStates.get(stateId);
        if (!state) return;
        
        // ページを更新
        if (i.customId === 'prev_page') {
          state.currentPage--;
        } else if (i.customId === 'next_page') {
          state.currentPage++;
        }
        
        const item = state.results[state.currentPage];
        // キャッシュにない場合もfetchで取得するように修正
        let channel = null;
        try {
          channel = await guild.channels.fetch(item.channel_id);
        } catch (err) {
          console.log('アーカイブチャンネルの取得に失敗:', err);
        }
        const jumpUrl = channel ? `https://discord.com/channels/${state.guildId}/${item.channel_id}/${item.message_id}` : 'リンク無効';
        
        // JSTで日付をフォーマット
        const jstDate = new Date(item.timestamp);
        jstDate.setHours(jstDate.getHours() + 9);
        const formattedDate = jstDate.toLocaleDateString('ja-JP');
        
        // アーカイブメッセージから画像URLを取得、失敗してもitemにmessage_urlがあればそれを使う
        let imageUrl = null;
        if (channel) {
          try {
            const archiveMessage = await channel.messages.fetch(item.message_id);
            if (archiveMessage.embeds.length > 0 && archiveMessage.embeds[0].image) {
              imageUrl = archiveMessage.embeds[0].image.url;
            }
          } catch (err) {
            console.log('アーカイブメッセージの取得に失敗、元のURLを使用します:', err);
          }
        }
        // アーカイブから取得できなかった場合、itemに保存されているURLを直接使用
        if (!imageUrl && item.message_url) {
          imageUrl = item.message_url;
        }
        
        // タイトルを更新
        let title = `🎮 ゲームギャラリー (${state.currentPage + 1}/${state.results.length})`;
        if (state.authorStr) {
          title = `🎮 投稿者検索結果: 「${state.authorStr}」さんの投稿 (${state.currentPage + 1}/${state.results.length})`;
        } else if (state.searchTags.length > 0) {
          title = `🎮 タグ検索結果: #${state.searchTags.join(' #')} (${state.currentPage + 1}/${state.results.length})`;
        } else {
          title = `🎮 あなたの投稿 (${state.currentPage + 1}/${state.results.length})`;
        }
        
        const newEmbed = new EmbedBuilder()
          .setTitle(title)
          .setColor(0x57F287)
          .addFields(
            { name: 'ID', value: String(item.id), inline: true },
            { name: '投稿日', value: formattedDate, inline: true },
            { name: '投稿者', value: item.author_name, inline: true },
            { name: 'タグ', value: item.tags ? item.tags.split(',').map(t => `#${t}`).join(' ') : 'なし' },
            { name: '説明', value: item.description || '説明なし' }
          )
          .setTimestamp();
        
        if (imageUrl) {
          newEmbed.setImage(imageUrl);
        }
        
        // ボタンの状態を更新
        const newRow = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder()
              .setCustomId('prev_page')
              .setLabel('◀ 前へ')
              .setStyle(ButtonStyle.Primary)
              .setDisabled(state.currentPage === 0),
            new ButtonBuilder()
              .setCustomId('next_page')
              .setLabel('次へ ▶')
              .setStyle(ButtonStyle.Primary)
              .setDisabled(state.currentPage === state.results.length - 1)
          );
        
        await i.update({ embeds: [newEmbed], components: [newRow] });
      });
      
      collector.on('end', () => {
        galleryStates.delete(stateId);
      });
      
    } catch (error) {
        console.error('galleryコマンドエラー:', error);
        interaction.editReply('コマンドの実行中にエラーが発生しました。');
      }
  }
  
  if (commandName === 'delete') {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    
    try {
      const mediaId = interaction.options.getInteger('media_id');
      
      // データベースからメディア情報と投稿者IDを取得（本人確認のため）
      db.get(`SELECT archive_message_id, author_id FROM media WHERE guild_id = ? AND id = ?`, [guild.id, mediaId], async (err, row) => {
        if (err || !row) {
          console.error('メディア取得エラー:', err);
          return interaction.editReply(`指定されたID:${mediaId}のメディアが見つかりませんでした。IDが正しいか確認してください。`);
        }

        // 投稿者本人、またはサーバーオーナー以外は削除不可
        if (row.author_id !== interaction.user.id && interaction.user.id !== guild.ownerId) {
          return interaction.editReply('このメディアを削除する権限がありません。自分が投稿したメディアのみ削除可能です。');
        }

        // アーカイブチャンネルのメッセージを削除
        const archiveChannel = await getOrCreateArchiveChannel(guild);
        if (archiveChannel && row.archive_message_id) {
          try {
            const archiveMessage = await archiveChannel.messages.fetch(row.archive_message_id);
            if (archiveMessage) {
              await archiveMessage.delete();
              console.log(`[${guild.name}] アーカイブチャンネルのメッセージ${row.archive_message_id}を削除しました`);
            }
          } catch (msgErr) {
            console.log('アーカイブメッセージの削除に失敗（既に削除済みの可能性あり）:', msgErr);
          }
        }

        // データベースから削除
        deleteMedia(guild.id, mediaId, async (err, changes) => {
          if (err) {
            console.error('データベース削除エラー:', err);
            return interaction.editReply('削除中にエラーが発生しました。');
          }
          
          interaction.editReply(`✅ ID:${mediaId}のメディアをアーカイブからも削除しました。`);
        });
      });
      
    } catch (error) {
      console.error('deleteコマンドエラー:', error);
      interaction.editReply('コマンドの実行中にエラーが発生しました。');
    }
  }
  
  if (commandName === 'help') {
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
});

// Botログイン
client.login(process.env.DISCORD_TOKEN);