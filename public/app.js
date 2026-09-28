import * as pdfjsLib from './vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdfjs/pdf.worker.min.mjs';

const $ = (id) => document.getElementById(id);
const fileInput = $('fileInput');
const canvas = $('mangaCanvas');
const canvasArea = $('canvasArea');
const pageWrap = $('pageWrap');
let pdf = null;
let pageNumber = 1;
let pageTurnDirection = 'next';
let renderTask = null;
let renderVersion = 0;
const pagePanels = new Map();
const renderedPages = new Set();
const renderingPages = new Set();
let toastTimer;
let googleButtonWaits = 0;

function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2300);
}

let currentUser = null;
let availableProviders = { google: false, googleClientId: '', discord: false };
let localMode = false;
let selectedRelease = null;
let selectedProfileAvatar = null;
let profileAvatarPreviewUrl = null;
let featuredReleases = [];
let featuredIndex = 0;
let featuredTimer = null;
let selectedType = 'all';
let selectedGenre = '';
let selectedAnimeFormat = 'all';
let pendingEpisodes = [];
let currentAnimeEpisodes = [];
let currentAnimeIndex = 0;
let currentAnimeReleaseId = '';
let currentAnimeTitle = '';
let currentAnimeFormat = 'series';
let lastTouchTap = 0;
let jumpFeedbackTimer = null;

function formatPlayerTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const value = Math.floor(seconds);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const remainder = String(value % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${remainder}` : `${minutes}:${remainder}`;
}

function updatePlayerTime() {
  const video = $('mangaVideo');
  $('playerCurrentTime').textContent = formatPlayerTime(video.currentTime);
  $('playerDuration').textContent = formatPlayerTime(video.duration);
  $('playerSeek').value = Number.isFinite(video.duration) && video.duration > 0
    ? String(Math.round((video.currentTime / video.duration) * 1000))
    : '0';
  $('playerSeek').style.setProperty('--seek-progress', `${$('playerSeek').value / 10}%`);
}

function updatePlayerButtons() {
  const video = $('mangaVideo');
  $('playerPlay').textContent = video.paused ? '▶' : 'Ⅱ';
  $('playerPlay').setAttribute('aria-label', video.paused ? 'Reproduzir' : 'Pausar');
  $('playerPreviousEpisode').disabled = currentAnimeIndex <= 0;
  $('playerNextEpisode').disabled = currentAnimeFormat !== 'series' || currentAnimeIndex >= currentAnimeEpisodes.length - 1;
  $('playerEpisodeLabel').textContent = currentAnimeFormat === 'series'
    ? `EP ${currentAnimeIndex + 1} / ${currentAnimeEpisodes.length}`
    : 'FILME';
  $('playerEpisodeTitle').textContent = currentAnimeFormat === 'series'
    ? `Episódio ${currentAnimeIndex + 1} · ${currentAnimeTitle}`
    : currentAnimeTitle;
}

function jumpVideo(seconds) {
  const video = $('mangaVideo');
  if (!Number.isFinite(video.duration)) return;
  video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + seconds));
  const feedback = $('playerJumpFeedback');
  feedback.textContent = seconds > 0 ? '＋10s' : '−10s';
  feedback.classList.remove('show');
  void feedback.offsetWidth;
  feedback.classList.add('show');
  clearTimeout(jumpFeedbackTimer);
  jumpFeedbackTimer = setTimeout(() => feedback.classList.remove('show'), 650);
}

function seekEpisode(index) {
  if (index < 0 || index >= currentAnimeEpisodes.length) return;
  currentAnimeIndex = index;
  const video = $('mangaVideo');
  $('fileName').textContent = currentAnimeFormat === 'series'
    ? `${currentAnimeTitle} · Episódio ${index + 1}`
    : currentAnimeTitle;
  video.src = `/api/releases/${encodeURIComponent(currentAnimeReleaseId)}?episode=${index}`;
  video.load();
  updatePlayerButtons();
  video.play().catch(() => updatePlayerButtons());
}

const playerVideo = $('mangaVideo');
playerVideo.addEventListener('timeupdate', updatePlayerTime);
playerVideo.addEventListener('loadedmetadata', updatePlayerTime);
playerVideo.addEventListener('durationchange', updatePlayerTime);
playerVideo.addEventListener('play', updatePlayerButtons);
playerVideo.addEventListener('pause', updatePlayerButtons);
playerVideo.addEventListener('click', () => {
  if (playerVideo.paused) playerVideo.play().catch(updatePlayerButtons);
  else playerVideo.pause();
});
playerVideo.addEventListener('dblclick', event => {
  event.preventDefault();
  const bounds = playerVideo.getBoundingClientRect();
  jumpVideo(event.clientX < bounds.left + bounds.width / 2 ? -10 : 10);
});
playerVideo.addEventListener('pointerup', event => {
  if (event.pointerType !== 'touch') return;
  const now = Date.now();
  if (now - lastTouchTap < 330) {
    const bounds = playerVideo.getBoundingClientRect();
    jumpVideo(event.clientX < bounds.left + bounds.width / 2 ? -10 : 10);
    lastTouchTap = 0;
  } else lastTouchTap = now;
});
$('playerPlay').addEventListener('click', () => playerVideo.paused ? playerVideo.play().catch(updatePlayerButtons) : playerVideo.pause());
$('playerPreviousEpisode').addEventListener('click', () => seekEpisode(currentAnimeIndex - 1));
$('playerNextEpisode').addEventListener('click', () => seekEpisode(currentAnimeIndex + 1));
$('playerRewind').addEventListener('click', () => jumpVideo(-10));
$('playerForward').addEventListener('click', () => jumpVideo(10));
$('playerSeek').addEventListener('input', event => {
  if (Number.isFinite(playerVideo.duration)) playerVideo.currentTime = (Number(event.target.value) / 1000) * playerVideo.duration;
});
$('playerFullscreen').addEventListener('click', async () => {
  const player = $('animePlayer');
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (player.requestFullscreen) await player.requestFullscreen();
    else if (playerVideo.webkitEnterFullscreen) playerVideo.webkitEnterFullscreen();
  } catch (error) { showToast('Não foi possível abrir a tela cheia.'); }
});
document.addEventListener('keydown', event => {
  if (!document.body.classList.contains('reader-anime') || event.repeat) return;
  if (event.target instanceof HTMLElement && event.target.matches('button,input,select,textarea')) return;
  if (event.code === 'Space' || event.key.toLowerCase() === 'k') {
    event.preventDefault();
    playerVideo.paused ? playerVideo.play().catch(updatePlayerButtons) : playerVideo.pause();
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault();
    event.shiftKey ? seekEpisode(currentAnimeIndex - 1) : jumpVideo(-10);
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    event.shiftKey ? seekEpisode(currentAnimeIndex + 1) : jumpVideo(10);
  } else if (event.key.toLowerCase() === 'f') {
    $('playerFullscreen').click();
  }
});

function applyCatalogFilters() {
  const query = $('searchInput').value.toLocaleLowerCase('pt-BR').trim();
  document.querySelectorAll('#releaseGrid .catalog-card').forEach(card => {
    const typeMatches = selectedType === 'all' || card.dataset.releaseType === selectedType;
    const genreMatches = !selectedGenre || card.dataset.genre.toLocaleLowerCase('pt-BR') === selectedGenre;
    const formatMatches = selectedType !== 'anime' || selectedAnimeFormat === 'all' || (card.dataset.animeFormat || 'series') === selectedAnimeFormat;
    const queryMatches = !query || `${card.dataset.title} ${card.dataset.authorName}`.toLocaleLowerCase('pt-BR').includes(query);
    card.hidden = !(typeMatches && genreMatches && formatMatches && queryMatches);
  });
}

function showFeatured(index) {
  if (!featuredReleases.length) return;
  featuredIndex = (index + featuredReleases.length) % featuredReleases.length;
  const release = featuredReleases[featuredIndex];
  $('featuredCategory').textContent = `${releaseCategoryLabel(release.type, release.animeFormat)} ORIGINAL`;
  $('featuredEyebrow').textContent = `EM DESTAQUE · ${release.genre || 'NOVA HISTÓRIA'}`;
  $('featuredTitle').textContent = release.title;
  $('featuredDescription').textContent = `Uma história original de ${release.authorName || 'um artista independente'}. Descubra esta obra no Kzinflix.`;
  $('featuredMeta').textContent = `AUTOR: ${release.authorName || 'não informado'}  ·  ${release.genre || 'Sem gênero'}`;
  $('featuredMeta').hidden = false;
  $('featuredCover').src = release.coverUrl;
  $('featuredCover').alt = `Capa de ${release.title}`;
  $('featuredArt').style.setProperty('--featured-image', `url("${release.coverUrl}")`);
  $('featuredArt').hidden = false;
  $('featuredOpen').hidden = false;
  $('featuredPosition').textContent = `${featuredIndex + 1} / ${featuredReleases.length}`;
  $('featuredOpen').onclick = () => openMangaDetails(release);
  $('featuredArt').classList.remove('featured-swap');
  requestAnimationFrame(() => $('featuredArt').classList.add('featured-swap'));
  const progress = $('featuredProgress');
  progress.style.animation = 'none';
  void progress.offsetWidth;
  progress.style.animation = '';
  clearTimeout(featuredTimer);
  featuredTimer = setTimeout(() => showFeatured(featuredIndex + 1), 10000);
}

$('featuredPrev').addEventListener('click', () => showFeatured(featuredIndex - 1));
$('featuredNext').addEventListener('click', () => showFeatured(featuredIndex + 1));
document.querySelectorAll('.type-chip').forEach(button => button.addEventListener('click', () => {
  document.querySelector('.type-chip.selected')?.classList.remove('selected');
  button.classList.add('selected');
  selectedType = button.dataset.type;
  $('animeShelf').hidden = selectedType !== 'anime';
  if (selectedType !== 'anime') {
    selectedAnimeFormat = 'all';
    document.querySelector('.anime-chip.selected')?.classList.remove('selected');
    document.querySelector('.anime-chip[data-anime-format="all"]').classList.add('selected');
  }
  applyCatalogFilters();
  $('lancamentos').scrollIntoView({ behavior: 'smooth', block: 'start' });
}));
document.querySelectorAll('.anime-chip').forEach(button => button.addEventListener('click', () => {
  document.querySelector('.anime-chip.selected')?.classList.remove('selected');
  button.classList.add('selected');
  selectedAnimeFormat = button.dataset.animeFormat;
  applyCatalogFilters();
}));

function openPicker() { fileInput.click(); }
$('errorRetry').addEventListener('click', () => location.assign('/'));
$('uploadButton').addEventListener('click', requestPublish);
$('heroUpload').addEventListener('click', requestPublish);
$('emptyUpload').addEventListener('click', requestPublish);
$('brandHome').addEventListener('click', event => {
  event.preventDefault();
  location.assign('/');
});
$('homeLink').addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
$('menuToggle').addEventListener('click', () => {
  const willOpen = $('siteNav').hidden;
  $('siteNav').hidden = !willOpen;
  $('menuToggle').setAttribute('aria-expanded', String(willOpen));
  $('menuToggle').setAttribute('aria-label', willOpen ? 'Fechar menu' : 'Abrir menu');
});
$('siteNav').addEventListener('click', event => {
  if (!event.target.closest('a')) return;
  $('siteNav').hidden = true;
  $('menuToggle').setAttribute('aria-expanded', 'false');
  $('menuToggle').setAttribute('aria-label', 'Abrir menu');
});
document.addEventListener('click', event => {
  if ($('siteNav').hidden || event.target.closest('.brand-menu')) return;
  $('siteNav').hidden = true;
  $('menuToggle').setAttribute('aria-expanded', 'false');
  $('menuToggle').setAttribute('aria-label', 'Abrir menu');
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || $('siteNav').hidden) return;
  $('siteNav').hidden = true;
  $('menuToggle').setAttribute('aria-expanded', 'false');
  $('menuToggle').setAttribute('aria-label', 'Abrir menu');
});
$('accountButton').addEventListener('click', () => currentUser ? location.assign('/perfil') : openAuthDialog());
$('profileLogo').addEventListener('click', event => { event.preventDefault(); returnHome(); });
$('closeMangaDetails').addEventListener('click', () => closeMangaDetails());
$('mangaDetailDialog').addEventListener('click', event => {
  if (event.target === $('mangaDetailDialog')) closeMangaDetails();
});
$('detailRead').addEventListener('click', () => {
  if (!selectedRelease) return;
  const button = $('detailRead');
  button.disabled = true;
  button.textContent = 'Abrindo capítulo…';
  openRelease(selectedRelease.id, true).finally(() => {
    button.disabled = false;
    button.innerHTML = '▶ &nbsp; Ler capítulo';
  });
});
$('detailAddEpisodes').addEventListener('click', () => $('appendEpisodeInput').click());
$('appendEpisodeInput').addEventListener('change', event => {
  const files = [...(event.target.files || [])];
  event.target.value = '';
  if (files.length) appendAnimeEpisodes(files);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('mangaDetailDialog').hidden) closeMangaDetails();
});
$('profileAvatarPicker').addEventListener('click', () => $('profileAvatarInput').click());
$('profileAvatarInput').addEventListener('change', () => {
  const file = $('profileAvatarInput').files?.[0];
  if (!file) return;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) {
    $('profileError').textContent = 'Escolha uma imagem JPG, PNG ou WebP de até 10 MB.';
    $('profileError').hidden = false;
    $('profileAvatarInput').value = '';
    return;
  }
  selectedProfileAvatar = file;
  $('profileAvatarReset').dataset.remove = 'false';
  if (profileAvatarPreviewUrl) URL.revokeObjectURL(profileAvatarPreviewUrl);
  profileAvatarPreviewUrl = URL.createObjectURL(file);
  $('profileAvatarPreview').src = profileAvatarPreviewUrl;
  $('profileAvatarPreview').hidden = false;
  $('profileAvatarPlaceholder').hidden = true;
  $('profileAvatarReset').hidden = false;
  $('profileError').hidden = true;
});
$('profileAvatarReset').addEventListener('click', () => {
  selectedProfileAvatar = null;
  $('profileAvatarReset').dataset.remove = 'true';
  $('profileAvatarInput').value = '';
  if (profileAvatarPreviewUrl) URL.revokeObjectURL(profileAvatarPreviewUrl);
  profileAvatarPreviewUrl = null;
  $('profileAvatarPreview').removeAttribute('src');
  $('profileAvatarPreview').hidden = true;
  $('profileAvatarPlaceholder').hidden = false;
  $('profileAvatarReset').hidden = true;
});
$('closeAuth').addEventListener('click', closeAuthDialog);
$('authDialog').addEventListener('click', event => { if (event.target === $('authDialog')) closeAuthDialog(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('authDialog').hidden) closeAuthDialog(); });
$('signOut').addEventListener('click', () => { location.href = '/auth/logout'; });
$('profileSignOut').addEventListener('click', () => { location.href = '/auth/logout'; });

function requestPublish() {
  if (currentUser?.isAdmin) { openPicker(); return; }
  openAuthDialog(currentUser
    ? 'Esta conta não tem permissão para publicar. Peça ao administrador para liberar seu e-mail.'
    : 'Entre com a conta autorizada para publicar novos mangás.');
}

function openAuthDialog(message = '') {
  $('authDialog').hidden = false;
  refreshAuth().then(async () => {
    if (message) $('authNotice').textContent = message;
    if (currentUser && sessionStorage.getItem('kzin_pending_release')) await resumePendingRelease();
  }).catch(() => {});
}

function closeAuthDialog() { $('authDialog').hidden = true; }

function renderGoogleSignIn() {
  const target = $('googleSignInContainer');
  target.replaceChildren();
  if (!availableProviders.googleClientId) {
    const fallback = document.createElement('button');
    fallback.className = 'provider-button google-fallback';
    fallback.innerHTML = '<span class="provider-g">G</span> Continuar com Google';
    fallback.addEventListener('click', () => {
      $('authNotice').textContent = 'Google ainda não foi configurado. Adicione o Client ID ao .env do servidor.';
    });
    target.append(fallback);
    return;
  }
  if (!window.google?.accounts?.id) {
    const fallback = document.createElement('button');
    fallback.className = 'provider-button google-fallback';
    fallback.innerHTML = '<span class="provider-g">G</span> Carregando Google…';
    fallback.addEventListener('click', () => {
      $('authNotice').textContent = 'O botão do Google ainda está carregando. Confira sua conexão e tente novamente.';
    });
    target.append(fallback);
    if (googleButtonWaits++ < 30) setTimeout(renderGoogleSignIn, 200);
    return;
  }
  googleButtonWaits = 0;
  window.google.accounts.id.initialize({
    client_id: availableProviders.googleClientId,
    callback: handleGoogleLogin,
    auto_select: false,
  });
  window.google.accounts.id.renderButton(target, {
    type: 'standard', theme: 'outline', size: 'large', text: 'continue_with',
    shape: 'pill', width: Math.floor(Math.min(340, target.getBoundingClientRect().width || 340)), locale: 'pt-BR',
  });
}

async function handleGoogleLogin(response) {
  try {
    const csrf = document.cookie.split('; ').find(cookie => cookie.startsWith('kzin_google_csrf='))?.split('=').slice(1).join('=') || '';
    const result = await fetch('/api/auth/google', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: response.credential, csrf_token: decodeURIComponent(csrf) }),
    });
    const body = await result.json();
    if (!result.ok) throw new Error(body.error || 'Não foi possível entrar com Google.');
    location.assign('/perfil');
  } catch (error) {
    $('authNotice').textContent = error.message || 'Não foi possível entrar com Google.';
  }
}

async function refreshAuth() {
  const response = await fetch('/api/me', { cache: 'no-store' });
  if (!response.ok) throw new Error('Falha ao obter sessão');
  const result = await response.json();
  currentUser = result.user;
  availableProviders = result.providers;
  localMode = Boolean(result.localMode);
  googleButtonWaits = 0;
  renderGoogleSignIn();
  const accountButton = $('accountButton');
  accountButton.replaceChildren();
  if (currentUser?.avatar) {
    const avatar = document.createElement('img');
    avatar.src = currentUser.avatar;
    avatar.alt = '';
    avatar.className = 'account-avatar';
    accountButton.append(avatar);
  }
  const accountLabel = document.createElement('span');
  accountLabel.textContent = currentUser ? currentUser.name.split(' ')[0] : 'Entrar';
  accountButton.append(accountLabel);
  $('uploadButton').hidden = !currentUser?.isAdmin;
  $('heroUpload').hidden = !currentUser?.isAdmin;
  $('emptyUpload').hidden = !currentUser?.isAdmin;
  updateEmptyReleasesCopy();
  $('authTitle').textContent = currentUser ? 'Sua conta' : 'Entre na Kzinflix';
  $('authDescription').textContent = currentUser
    ? (localMode ? 'Modo local ativo: você pode publicar neste servidor sem configurar login.' : currentUser.isAdmin ? 'Você está conectado e pode publicar novos mangás.' : 'Você está conectado. A publicação é restrita às contas administradoras.')
    : 'Use sua conta Google para acessar a Kzinflix.';
  $('authProfile').hidden = !currentUser;
  $('authOptions').hidden = Boolean(currentUser) && !localMode;
  $('signOut').hidden = !currentUser || localMode;
  if (currentUser) {
    $('authName').textContent = currentUser.name;
    $('authEmail').textContent = currentUser.email;
    $('authAvatar').src = currentUser.avatar || '';
    $('authAvatar').hidden = !currentUser.avatar;
    $('authNotice').textContent = '';
  } else {
    $('authNotice').textContent = localMode
      ? 'Para publicar neste localhost, use os botões azuis da página. Configure OAuth no .env para habilitar login.'
      : !availableProviders.google ? 'Login Google ainda não configurado. Adicione o Client ID ao .env do servidor.' : '';
  }
}

async function openProfile(navigate = true) {
  if (navigate) {
    location.assign('/perfil');
    return;
  }
  if (!currentUser) {
    openAuthDialog('Entre na sua conta para acessar o perfil.');
    return;
  }
  document.body.classList.remove('reader-open');
  stopReleasePlayer();
  $('catalogPage').hidden = true;
  $('profilePage').hidden = false;
  $('profileError').hidden = true;
  $('profileOk').disabled = false;
  $('profileOk').textContent = 'OK';
  $('profileSignOut').hidden = localMode;
  try {
    const response = await fetch('/api/profile', { cache: 'no-store' });
    const profile = await response.json();
    if (!response.ok) throw new Error(profile.error || 'Não foi possível carregar seu perfil.');
  $('profileDisplayName').value = profile.displayName || '';
  $('profileDisplayName').placeholder = currentUser.name;
    selectedProfileAvatar = null;
    $('profileAvatarReset').dataset.remove = 'false';
    $('profileAvatarInput').value = '';
    if (profileAvatarPreviewUrl) URL.revokeObjectURL(profileAvatarPreviewUrl);
    profileAvatarPreviewUrl = null;
    const avatarPreview = profile.avatarUrl || profile.accountAvatar;
    if (avatarPreview) $('profileAvatarPreview').src = avatarPreview;
    else $('profileAvatarPreview').removeAttribute('src');
    $('profileAvatarPreview').hidden = !avatarPreview;
    $('profileAvatarPlaceholder').hidden = Boolean(avatarPreview);
    $('profileAvatarReset').hidden = !profile.avatarUrl;
  } catch (error) {
    $('profileError').textContent = error.message;
    $('profileError').hidden = false;
  }
  window.scrollTo({ top: 0 });
}

function returnHome() {
  sessionStorage.removeItem('kzin_pending_release');
  location.assign('/');
}

$('profileForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('profileOk');
  button.disabled = true;
  button.textContent = 'Salvando…';
  $('profileError').hidden = true;
  try {
    const form = new FormData();
    form.append('displayName', $('profileDisplayName').value.trim());
    form.append('removeAvatar', $('profileAvatarReset').dataset.remove === 'true' ? '1' : '0');
    if (selectedProfileAvatar) form.append('avatar', selectedProfileAvatar);
    const response = await fetch('/api/profile', { method: 'PUT', body: form });
    const result = await readApiJson(response);
    if (!response.ok) throw new Error(result.error || 'Não foi possível salvar seu perfil.');
    returnHome();
  } catch (error) {
    $('profileError').textContent = error.message;
    $('profileError').hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = 'OK';
  }
});

function updateEmptyReleasesCopy() {
  const title = $('emptyReleasesTitle');
  const description = $('emptyReleasesDescription');
  if (currentUser?.isAdmin) {
    title.textContent = 'Os lançamentos começam aqui';
    description.textContent = 'Publique a primeira obra para ela aparecer nesta coleção.';
  } else if (currentUser) {
    title.textContent = 'Uma nova história vem aí';
    description.textContent = 'Ainda não há obras publicadas. Volte em breve para conferir as novidades da coleção.';
  } else {
    title.textContent = 'Sua próxima leitura começa aqui';
    description.textContent = 'Entre na sua conta para acompanhar os lançamentos e ler ou assistir às obras da coleção.';
  }
}
$('searchInput').addEventListener('input', event => {
  document.querySelector('.genre-list .selected')?.classList.remove('selected');
  selectedGenre = '';
  applyCatalogFilters();
});
document.querySelectorAll('.genre-list button').forEach(button => {
  button.addEventListener('click', () => {
    document.querySelector('.genre-list .selected')?.classList.remove('selected');
    button.classList.add('selected');
    $('searchInput').value = '';
    selectedGenre = button.textContent.toLocaleLowerCase('pt-BR');
    applyCatalogFilters();
    $('lancamentos').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) beginPublish(file);
  fileInput.value = '';
});

let pendingMedia = null;
let pendingCover = null;
let coverPreviewUrl = null;
let nameEdited = false;

function makeSlug(value) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70).replace(/-+$/g, '');
}

function releaseRoutePrefix(type) {
  return ({ manga: 'manga', manhwa: 'manhwa', anime: 'anime' })[type] || 'manga';
}

function releaseRoute(release) {
  return `/${releaseRoutePrefix(release.type)}/${encodeURIComponent(release.slug)}`;
}

function updateReleaseSlugPrefix() {
  $('releaseSlugPrefix').textContent = `/${releaseRoutePrefix($('releaseType').value)}/`;
}

function beginPublish(file) {
  const extension = file.name.toLowerCase().match(/\.[^.]+$/)?.[0] || '';
  const isVideo = ['.mp4', '.webm'].includes(extension);
  const isDocument = extension === '.pdf';
  if (!isVideo && !isDocument) {
    showToast('Escolha páginas em PDF ou um vídeo MP4/WebM.');
    return;
  }
  if (file.size > 2 * 1024 * 1024 * 1024) {
    showToast('O arquivo precisa ter no máximo 2 GB.');
    return;
  }
  pendingMedia = file;
  pendingEpisodes = isVideo ? [file] : [];
  pendingCover = null;
  nameEdited = false;
  const baseName = file.name.replace(/\.(pdf|mp4|webm)$/i, '').replace(/[_-]+/g, ' ');
  $('selectedChapter').textContent = `${isVideo ? 'Vídeo' : 'Capítulo'}: ${baseName} · ${formatBytes(file.size)}`;
  $('releaseName').value = baseName;
  $('releaseAuthor').value = '';
  $('releaseSlug').value = makeSlug($('releaseName').value);
  $('releaseType').value = isVideo ? 'anime' : '';
  updateReleaseSlugPrefix();
  $('animeFormat').value = 'series';
  $('episodeInput').value = '';
  refreshAnimePublishOptions();
  renderPendingEpisodes();
  $('releaseGenre').value = '';
  $('coverInput').value = '';
  $('coverPreview').hidden = true;
  $('coverPlaceholder').hidden = false;
  $('coverLabel').textContent = 'Escolher imagem';
  $('publishError').hidden = true;
  $('publishDialog').hidden = false;
  setTimeout(() => $('releaseName').focus(), 30);
}

function refreshAnimePublishOptions() {
  const isAnime = $('releaseType').value === 'anime';
  $('animePublishOptions').hidden = !isAnime;
  $('episodeAdder').hidden = !isAnime || $('animeFormat').value === 'movie';
}

function renderPendingEpisodes() {
  const list = $('episodeList');
  list.replaceChildren();
  pendingEpisodes.forEach((file, index) => {
    const row = document.createElement('li');
    row.textContent = `Episódio ${index + 1} · ${file.name} · ${formatBytes(file.size)}`;
    list.append(row);
  });
  $('episodeHint').textContent = pendingEpisodes.length > 1
    ? `${pendingEpisodes.length} vídeos na sequência escolhida.`
    : 'Adicione os próximos episódios na ordem de exibição.';
}

$('releaseType').addEventListener('change', () => {
  updateReleaseSlugPrefix();
  refreshAnimePublishOptions();
  if ($('releaseType').value === 'anime' && pendingMedia && !pendingEpisodes.length) pendingEpisodes = [pendingMedia];
  renderPendingEpisodes();
});
$('animeFormat').addEventListener('change', () => {
  if ($('animeFormat').value === 'movie') pendingEpisodes = pendingEpisodes.slice(0, 1);
  refreshAnimePublishOptions();
  renderPendingEpisodes();
});
$('episodePicker').addEventListener('click', () => $('episodeInput').click());
$('episodeInput').addEventListener('change', event => {
  const additions = [...(event.target.files || [])];
  const invalid = additions.find(file => !/\.(mp4|webm)$/i.test(file.name) || file.size > 2 * 1024 * 1024 * 1024);
  if (invalid) showPublishError('Adicione somente vídeos MP4/WebM de até 2 GB cada.');
  else if ([...pendingEpisodes, ...additions].reduce((sum, file) => sum + file.size, 0) > 2 * 1024 * 1024 * 1024) showPublishError('A soma dos vídeos não pode passar de 2 GB.');
  else {
    pendingEpisodes.push(...additions);
    $('publishError').hidden = true;
    renderPendingEpisodes();
  }
  event.target.value = '';
});

$('releaseName').addEventListener('input', () => {
  if (!nameEdited) $('releaseSlug').value = makeSlug($('releaseName').value);
});
$('releaseSlug').addEventListener('input', () => { nameEdited = true; });
$('coverPicker').addEventListener('click', () => $('coverInput').click());
$('coverInput').addEventListener('change', () => {
  const file = $('coverInput').files?.[0];
  if (!file) return;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) {
    showPublishError('Use uma capa JPG, PNG ou WebP de até 10 MB.');
    $('coverInput').value = '';
    return;
  }
  pendingCover = file;
  if (coverPreviewUrl) URL.revokeObjectURL(coverPreviewUrl);
  coverPreviewUrl = URL.createObjectURL(file);
  $('coverPreview').src = coverPreviewUrl;
  $('coverPreview').hidden = false;
  $('coverPlaceholder').hidden = true;
  $('coverLabel').textContent = file.name;
  $('publishError').hidden = true;
});

function showPublishError(message) {
  $('publishError').textContent = message;
  $('publishError').hidden = false;
}

function closePublish() {
  $('publishDialog').hidden = true;
  pendingMedia = null;
  pendingCover = null;
  pendingEpisodes = [];
  $('episodeList').replaceChildren();
  if (coverPreviewUrl) URL.revokeObjectURL(coverPreviewUrl);
  coverPreviewUrl = null;
}
$('closePublish').addEventListener('click', closePublish);
$('cancelPublish').addEventListener('click', closePublish);
$('publishDialog').addEventListener('click', event => { if (event.target === $('publishDialog')) closePublish(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('publishDialog').hidden) closePublish(); });
$('publishForm').addEventListener('submit', event => {
  event.preventDefault();
  if (!pendingMedia) return showPublishError('Selecione as páginas ou o vídeo da obra.');
  if (!pendingCover) return showPublishError('Escolha uma imagem para a capa.');
  if (!$('releaseType').value) return showPublishError('Escolha a categoria da obra.');
  const ext = pendingMedia.name.toLowerCase().match(/\.[^.]+$/)?.[0] || '';
  const anime = $('releaseType').value === 'anime';
  const selectedFiles = anime ? pendingEpisodes : [pendingMedia];
  if (selectedFiles.some(file => file.size > 2 * 1024 * 1024 * 1024)
      || selectedFiles.reduce((sum, file) => sum + file.size, 0) > 2 * 1024 * 1024 * 1024) {
    return showPublishError('Cada arquivo e o total do envio devem ter no máximo 2 GB.');
  }
  if (anime && !['.mp4', '.webm'].includes(ext)) return showPublishError('Para Anime, selecione um vídeo MP4 ou WebM.');
  if (anime && $('animeFormat').value === 'series' && !pendingEpisodes.length) return showPublishError('Adicione ao menos um vídeo para a série.');
  if (anime && $('animeFormat').value === 'movie' && pendingEpisodes.length > 1) return showPublishError('Filmes aceitam somente um vídeo.');
  if (!anime && ext !== '.pdf') return showPublishError('Para Mangá ou Manhwa, selecione um arquivo com as páginas em PDF.');
  if (!$('releaseSlug').value) return showPublishError('O nome precisa ter letras ou números para gerar uma URL.');
  if (!$('releaseAuthor').value.trim()) return showPublishError('Informe o nome do autor.');
  addRelease(pendingMedia, pendingCover, $('releaseName').value.trim(), $('releaseAuthor').value.trim(), $('releaseSlug').value, $('releaseGenre').value, $('releaseType').value, $('animeFormat').value, pendingEpisodes);
});

async function addRelease(file, cover, title, authorName, slug, genre, type, animeFormat, episodes) {
  const button = $('publishSubmit');
  button.disabled = true;
  button.textContent = 'Publicando…';
  $('publishError').hidden = true;
  const uploadIds = [];
  try {
    const mediaFiles = type === 'anime' ? episodes : [file];
    const totalBytes = mediaFiles.reduce((sum, item) => sum + item.size, 0);
    if (mediaFiles.some(item => item.size > 2 * 1024 * 1024 * 1024) || totalBytes > 2 * 1024 * 1024 * 1024) {
      throw new Error('Cada arquivo e a soma do envio devem ter no máximo 2 GB.');
    }
    for (let fileIndex = 0; fileIndex < mediaFiles.length; fileIndex++) {
      const mediaFile = mediaFiles[fileIndex];
      uploadIds.push(await uploadFileInChunks(mediaFile, (chunk, total) => {
        button.textContent = `Enviando ${fileIndex + 1}/${mediaFiles.length} · bloco ${chunk}/${total}`;
      }));
    }
    const form = new FormData();
    form.append('cover', cover);
    form.append('title', title);
    form.append('authorName', authorName);
    form.append('slug', slug);
    form.append('genre', genre);
    form.append('type', type);
    form.append('animeFormat', animeFormat);
    form.append('uploadIds', JSON.stringify(uploadIds));
    button.textContent = 'Finalizando publicação…';
    const response = await fetch('/api/releases', { method: 'POST', body: form });
    const result = await readApiJson(response);
    if (!response.ok) throw new Error(result.error || 'Falha no envio');
    location.assign('/#lancamentos');
  } catch (error) {
    await cancelChunkedUploads(uploadIds);
    console.error('Could not save release', error);
    showPublishError(error.message || 'Não foi possível publicar. Confira os arquivos e tente novamente.');
  } finally {
    button.disabled = false;
    button.textContent = 'Publicar';
  }
}

async function uploadFileInChunks(file, onProgress = () => {}) {
  const startResponse = await fetch('/api/uploads/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName: file.name, size: file.size }),
  });
  const start = await readApiJson(startResponse);
  if (!startResponse.ok) throw new Error(start.error || 'Não foi possível iniciar o envio.');
  const chunkSize = start.chunkSize;
  try {
    for (let index = 0; index < start.chunks; index++) {
      const chunk = file.slice(index * chunkSize, Math.min(file.size, (index + 1) * chunkSize));
      const response = await fetch(`/api/uploads/${start.uploadId}/${index}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: chunk,
      });
      const result = await readApiJson(response);
      if (!response.ok) throw new Error(result.error || 'Falha ao enviar um bloco do arquivo.');
      onProgress(index + 1, start.chunks);
    }
    return start.uploadId;
  } catch (error) {
    await cancelChunkedUploads([start.uploadId]);
    throw error;
  }
}

async function readApiJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    const service = response.status >= 500 ? 'servidor' : 'túnel';
    throw new Error(`Resposta inválida do ${service} (HTTP ${response.status}). Tente novamente.`);
  }
}

async function cancelChunkedUploads(uploadIds) {
  if (!uploadIds.length) return;
  try {
    await fetch('/api/uploads/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadIds }),
    });
  } catch {}
}

async function renderReleases() {
  const response = await fetch('/api/releases');
  if (!response.ok) throw new Error('API de lançamentos indisponível');
  const releases = (await response.json()).sort((a, b) => b.addedAt - a.addedAt);
  featuredReleases = releases.slice(0, 5);
  if (featuredReleases.length) showFeatured(0);
  else {
    clearTimeout(featuredTimer);
    featuredTimer = null;
    $('featuredArt').hidden = true;
    $('featuredMeta').hidden = true;
    $('featuredOpen').hidden = true;
    $('featuredCategory').textContent = 'KZINFLIX ORIGINAL';
    $('featuredEyebrow').textContent = 'HISTÓRIAS INDEPENDENTES';
    $('featuredTitle').innerHTML = 'Feito por quem<br>ama contar.';
    $('featuredDescription').textContent = 'Leia e assista a obras originais publicadas pelos nossos queridos artistas.';
  }
  const grid = $('releaseGrid');
  grid.replaceChildren();
  $('releaseCount').textContent = `${releases.length} ${releases.length === 1 ? 'publicação' : 'publicações'}`;
  $('emptyReleases').hidden = releases.length > 0;
  updateEmptyReleasesCopy();
  for (const [index, release] of releases.entries()) {
    const card = document.createElement('article');
    card.className = 'catalog-card release-card';
    card.style.setProperty('--card-delay', `${Math.min(index, 8) * 55}ms`);
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.dataset.title = release.title;
    card.dataset.releaseId = release.id;
    card.dataset.fileName = release.fileName;
    card.dataset.slug = release.slug;
    card.dataset.coverUrl = release.coverUrl;
    card.dataset.releaseType = release.type || 'manga';
    card.dataset.animeFormat = release.animeFormat || 'series';
    card.dataset.episodes = JSON.stringify(release.episodes || []);
    card.dataset.authorName = release.authorName || 'não informado';
    card.dataset.genre = release.genre;
    const poster = document.createElement('div');
    poster.className = 'catalog-poster';
    const cover = document.createElement('img');
    cover.className = 'release-cover';
    cover.src = release.coverUrl;
    cover.alt = `Capa de ${release.title}`;
    poster.append(cover);
    const type = document.createElement('span');
    type.textContent = releaseCategoryLabel(release.type, release.animeFormat);
    poster.append(type);
    const info = document.createElement('div');
    info.className = 'catalog-info';
    const heading = document.createElement('h3');
    heading.textContent = release.title;
    const author = document.createElement('p');
    author.className = 'release-author';
    author.textContent = `Autor: ${release.authorName || 'não informado'}`;
    const meta = document.createElement('p');
    meta.className = 'release-meta';
    const episodeCount = release.type === 'anime' && release.animeFormat !== 'movie' && release.episodes?.length
      ? ` · ${release.episodes.length} ${release.episodes.length === 1 ? 'episódio' : 'episódios'}`
      : '';
    meta.textContent = `${release.genre} · ${new Date(release.addedAt).toLocaleDateString('pt-BR')}${episodeCount}`;
    info.append(heading, author, meta);
    if (currentUser?.isAdmin) {
      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'delete-release';
      deleteButton.textContent = 'Apagar';
      deleteButton.setAttribute('aria-label', `Apagar ${release.title}`);
      deleteButton.addEventListener('click', event => {
        event.stopPropagation();
        deleteRelease(release.id, release.title);
      });
      poster.append(deleteButton);
    }
    card.append(poster, info);
    card.addEventListener('click', () => openMangaDetails(release));
    card.addEventListener('keydown', event => {
      if (event.target === card && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openMangaDetails(release); }
    });
    grid.append(card);
  }
  applyCatalogFilters();
}

function openMangaDetails(release, navigate = true) {
  if (navigate && release.slug) {
    const target = releaseRoute(release);
    if (location.pathname !== target) {
      location.assign(target);
      return;
    }
  }
  selectedRelease = release;
  $('detailCover').src = release.coverUrl;
  $('detailCover').alt = `Capa de ${release.title}`;
  $('detailCategory').textContent = `${releaseCategoryLabel(release.type, release.animeFormat)} ORIGINAL`;
  $('detailTitle').textContent = release.title;
  $('detailAuthor').textContent = `Autor: ${release.authorName || 'não informado'}`;
  $('detailGenre').textContent = release.genre || 'Sem gênero';
  $('detailDate').textContent = `Publicado em ${new Date(release.addedAt).toLocaleDateString('pt-BR')}`;
  if (release.type === 'anime' && (release.animeFormat || 'series') === 'series' && release.episodes?.length) {
    $('detailDate').textContent += ` · ${release.episodes.length} ${release.episodes.length === 1 ? 'episódio' : 'episódios'}`;
  }
  $('detailRead').textContent = release.type === 'anime' ? '▶  Assistir anime' : '▶  Ler obra';
  $('detailAddEpisodes').hidden = !(currentUser?.isAdmin && release.type === 'anime' && (release.animeFormat || 'series') === 'series');
  $('episodeUpdateStatus').hidden = true;
  $('mangaDetailDialog').hidden = false;
}

function releaseCategoryLabel(type, animeFormat = 'series') {
  if (type === 'anime') return animeFormat === 'movie' ? 'ANIME · FILME' : 'ANIME · PADRÃO';
  return ({ manga: 'MANGÁ', manhwa: 'MANHWA' })[type] || 'MANGÁ';
}

async function appendAnimeEpisodes(files) {
  if (!selectedRelease || !currentUser?.isAdmin) return;
  const invalid = files.find(file => !/\.(mp4|webm)$/i.test(file.name) || file.size > 2 * 1024 * 1024 * 1024);
  if (invalid) {
    showToast('Escolha vídeos MP4/WebM de até 2 GB cada.');
    return;
  }
  if (files.reduce((sum, file) => sum + file.size, 0) > 2 * 1024 * 1024 * 1024) {
    showToast('A soma dos episódios não pode passar de 2 GB.');
    return;
  }
  const button = $('detailAddEpisodes');
  const previousText = button.textContent;
  button.disabled = true;
  button.textContent = 'Preparando episódios…';
  const uploadIds = [];
  try {
    for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
      uploadIds.push(await uploadFileInChunks(files[fileIndex], (chunk, total) => {
        button.textContent = `Enviando ${fileIndex + 1}/${files.length} · bloco ${chunk}/${total}`;
      }));
    }
    const form = new FormData();
    form.append('uploadIds', JSON.stringify(uploadIds));
    button.textContent = 'Finalizando episódios…';
    const response = await fetch(`/api/releases/${encodeURIComponent(selectedRelease.id)}/episodes`, { method: 'POST', body: form });
    const result = await readApiJson(response);
    if (!response.ok) throw new Error(result.error || 'Não foi possível adicionar os episódios.');
    selectedRelease = result.release;
    $('detailDate').textContent = `Publicado em ${new Date(selectedRelease.addedAt).toLocaleDateString('pt-BR')} · ${selectedRelease.episodes.length} ${selectedRelease.episodes.length === 1 ? 'episódio' : 'episódios'}`;
    $('episodeUpdateStatus').textContent = `${result.appended} ${result.appended === 1 ? 'episódio adicionado' : 'episódios adicionados'} à sequência.`;
    $('episodeUpdateStatus').hidden = false;
    await renderReleases();
  } catch (error) {
    await cancelChunkedUploads(uploadIds);
    showToast(error.message || 'Não foi possível adicionar os episódios.');
  } finally {
    button.disabled = false;
    button.textContent = previousText;
  }
}

function stopReleasePlayer() {
  const video = $('mangaVideo');
  video.pause();
  video.removeAttribute('src');
  video.removeAttribute('poster');
  video.onerror = null;
  video.onended = null;
  video.load();
  $('animePlayer').hidden = true;
  $('readerBottom').hidden = false;
  document.body.classList.remove('reader-anime');
}

function closeMangaDetails() {
  if (/^\/(?:m|manga|manhwa|anime)\//.test(location.pathname)) location.assign('/');
  else $('mangaDetailDialog').hidden = true;
  selectedRelease = null;
}

async function deleteRelease(id, title) {
  if (!window.confirm(`Apagar “${title}” e seus arquivos? Esta ação não pode ser desfeita.`)) return;
  try {
    const response = await fetch(`/api/releases/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Não foi possível apagar a publicação.');
    await renderReleases();
    showToast('Publicação apagada.');
  } catch (error) {
    showToast(error.message || 'Não foi possível apagar a publicação.');
  }
}

async function openRelease(id, navigate = true) {
  if (!currentUser) {
    sessionStorage.setItem('kzin_pending_release', id);
    $('mangaDetailDialog').hidden = true;
    openAuthDialog('Entre na sua conta para ler este mangá.');
    return;
  }
  try {
    const card = [...document.querySelectorAll('[data-release-id]')].find(item => item.dataset.releaseId === id);
    const release = selectedRelease?.id === id ? selectedRelease : null;
    const type = card?.dataset.releaseType || release?.type || 'manga';
    const title = card?.dataset.title || release?.title || 'Obra';
    const coverUrl = card?.dataset.coverUrl || release?.coverUrl || '';
    const slug = card?.dataset.slug || release?.slug;
    if (navigate && slug) {
      location.assign(`${releaseRoute({ slug, type })}/${type === 'anime' ? 'assistir' : 'ler'}`);
      return;
    }
    const readerRoute = card?.dataset.slug || release?.slug;
    if (readerRoute) $('readerBack').href = releaseRoute({ slug: readerRoute, type });
    $('mangaDetailDialog').hidden = true;
    document.body.classList.add('reader-open');
    $('fileName').textContent = title;
    if (type === 'anime') {
      pdf = null;
      pageWrap.hidden = true;
      $('loading').classList.remove('visible');
      $('errorCard').hidden = true;
      $('readerBottom').hidden = true;
      const video = $('mangaVideo');
      video.poster = coverUrl;
      currentAnimeEpisodes = release?.episodes?.length ? release.episodes : JSON.parse(card?.dataset.episodes || '[]');
      if (!currentAnimeEpisodes.length) currentAnimeEpisodes = [{}];
      currentAnimeIndex = 0;
      currentAnimeReleaseId = id;
      currentAnimeTitle = title;
      currentAnimeFormat = release?.animeFormat || card?.dataset.animeFormat || 'series';
      $('playerTitle').textContent = title.toLocaleUpperCase('pt-BR');
      $('animePlayer').hidden = false;
      video.onended = () => {
        if (currentAnimeFormat === 'series' && currentAnimeIndex + 1 < currentAnimeEpisodes.length) {
          showToast(`Episódio ${currentAnimeIndex + 2} começando…`);
          seekEpisode(currentAnimeIndex + 1);
        } else if (currentAnimeFormat === 'series') {
          showToast('Você chegou ao fim dos episódios publicados.');
        }
      };
      document.body.classList.add('reader-anime');
      video.onerror = () => showToast('Não foi possível reproduzir este vídeo.');
      seekEpisode(0);
      return;
    }
    stopReleasePlayer();
    const response = await fetch(`/api/releases/${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error('Capítulo não encontrado');
    const file = await response.blob();
    await loadFile(new File([file], `${title}.pdf`, { type: 'application/pdf' }));
  } catch (error) {
    console.error('Could not open release', error);
    showToast('Não foi possível abrir este mangá.');
  }
}

async function resumePendingRelease() {
  const id = sessionStorage.getItem('kzin_pending_release');
  if (!id || !currentUser) return;
  sessionStorage.removeItem('kzin_pending_release');
  await openRelease(id);
}

async function initializeCatalog() {
  await refreshAuth();
  await renderReleases();
  if (window.location.pathname.replace(/\/$/, '') === '/perfil') {
    if (currentUser) await openProfile(false);
    else openAuthDialog('Entre na sua conta para personalizar seu perfil.');
    return;
  }
  await resumePendingRelease();
  const authError = new URLSearchParams(location.search).get('auth_error');
  if (authError) {
    const messages = {
      google_not_configured: 'O login Google ainda não foi configurado.',
      denied: 'O login foi cancelado.',
      state: 'Não foi possível validar este login. Tente novamente.',
      provider_error: 'O provedor não conseguiu concluir o login. Confira a configuração.',
      missing_code: 'O provedor não retornou o código de login.',
    };
    openAuthDialog(messages[authError] || 'Não foi possível entrar.');
    history.replaceState({}, '', location.pathname + location.hash);
  }
  const match = window.location.pathname.match(/^\/(?:m|manga|manhwa|anime)\/([^/]+)(?:\/(ler|assistir))?\/?$/);
  if (match) {
    const response = await fetch(`/api/releases/by-slug/${encodeURIComponent(decodeURIComponent(match[1]))}`);
    if (response.ok) {
      const release = await response.json();
      openMangaDetails(release, false);
      if (match[2]) await openRelease(release.id, false);
    }
  }
}

function enableScrollAnimations() {
  const targets = document.querySelectorAll('.catalog-section, .catalog-footer');
  if (!('IntersectionObserver' in window)) {
    targets.forEach(target => target.classList.add('is-visible'));
    return;
  }
  document.documentElement.classList.add('motion-ready');
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    }
  }, { threshold: 0.12 });
  targets.forEach(target => observer.observe(target));
}
enableScrollAnimations();

initializeCatalog().catch(error => {
  console.error('Could not read local library', error);
  showToast('Não foi possível carregar o catálogo.');
});
window.addEventListener('popstate', async () => {
  if (window.location.pathname.replace(/\/$/, '') === '/perfil') {
    stopReleasePlayer();
    $('catalogPage').hidden = true;
    if (currentUser) await openProfile(false);
    else openAuthDialog('Entre na sua conta para acessar o perfil.');
    return;
  }
  $('mangaDetailDialog').hidden = true;
  selectedRelease = null;
  $('profilePage').hidden = true;
  $('catalogPage').hidden = false;
  const match = window.location.pathname.match(/^\/(?:m|manga|manhwa|anime)\/([^/]+)(?:\/(ler|assistir))?\/?$/);
  if (!match) { document.body.classList.remove('reader-open'); stopReleasePlayer(); return; }
  try {
    const response = await fetch(`/api/releases/by-slug/${encodeURIComponent(decodeURIComponent(match[1]))}`);
    if (!response.ok) return;
    const release = await response.json();
    document.body.classList.remove('reader-open');
    stopReleasePlayer();
    openMangaDetails(release, false);
    if (match[2]) await openRelease(release.id, false);
  } catch (error) { console.error('Could not open manga route', error); }
});

async function loadFile(file) {
  if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
    showToast('Escolha um capítulo válido para abrir.');
    return;
  }
  // Show the reader before rendering so its page area has measurable dimensions.
  document.body.classList.add('reader-open');
  $('errorCard').hidden = true;
  pageWrap.hidden = true;
  $('loading').classList.add('visible');
  $('fileName').textContent = file.name.replace(/\.pdf$/i, '') || 'Mangá';
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const loaded = await pdfjsLib.getDocument({ data: bytes }).promise;
    pdf = loaded;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    pageNumber = 1;
    pageTurnDirection = 'next';
    $('pageCount').textContent = loaded.numPages;
    $('pageInput').max = loaded.numPages;
    $('pageInput').disabled = false;
    ['prevPage', 'nextPage'].forEach(id => $(id).disabled = false);
    pageWrap.hidden = false;
    await buildPageStack();
    await renderPage();
    document.body.classList.add('reader-open');
  } catch (err) {
    console.error('Chapter could not be opened', err);
    pdf = null;
    $('errorCard').hidden = false;
  } finally {
    $('loading').classList.remove('visible');
  }
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}

function availableScale(viewport) {
  const padding = window.innerWidth < 760 ? 12 : 36;
  const areaWidth = canvasArea.clientWidth || window.innerWidth;
  const width = Math.max(200, Math.min(areaWidth - padding, 1300));
  return Math.min(width / viewport.width, 1.8);
}

async function buildPageStack() {
  if (!pdf) return;
  renderTask?.cancel();
  renderTask = null;
  renderedPages.clear();
  renderingPages.clear();
  pagePanels.clear();
  pageWrap.replaceChildren();
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const panel = document.createElement('section');
  panel.className = 'manga-page';
  panel.dataset.page = pageNumber;
  panel.dataset.turn = pageTurnDirection;
  panel.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
  canvas.dataset.page = pageNumber;
  panel.append(canvas);
  pageWrap.append(panel);
  pagePanels.set(pageNumber, panel);
}

function updatePageControls() {
  $('pageInput').value = pageNumber;
  $('prevPage').disabled = pageNumber <= 1;
  $('nextPage').disabled = pageNumber >= pdf.numPages;
}

async function renderNearbyPages(center) {
  if (pagePanels.has(center) && !renderedPages.has(center) && !renderingPages.has(center)) {
    await renderOnePage(center);
  }
}

async function renderOnePage(n) {
  if (!pdf || !pagePanels.has(n)) return;
  renderingPages.add(n);
  let task = null;
  try {
    const page = await pdf.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: availableScale(base) });
    const pageCanvas = pagePanels.get(n).querySelector('canvas');
    const pageContext = pageCanvas.getContext('2d', { alpha: false });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    pageCanvas.width = Math.floor(viewport.width * dpr);
    pageCanvas.height = Math.floor(viewport.height * dpr);
    pageCanvas.style.width = `${Math.floor(viewport.width)}px`;
    pageCanvas.style.height = `${Math.floor(viewport.height)}px`;
    pagePanels.get(n).style.width = `${Math.floor(viewport.width)}px`;
    pagePanels.get(n).style.aspectRatio = `${viewport.width} / ${viewport.height}`;
    task = page.render({ canvasContext: pageContext, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null, background: '#ffffff' });
    renderTask = task;
    await task.promise;
    if (renderTask === task) renderTask = null;
    renderedPages.add(n);
  } catch (err) {
    if (renderTask === task) renderTask = null;
    if (err?.name !== 'RenderingCancelledException') console.error('Page rendering failed', err);
  } finally {
    renderingPages.delete(n);
  }
}

async function renderPage(jump = false) {
  if (!pdf) return;
  const version = ++renderVersion;
  updatePageControls();
  $('pageInput').disabled = false;
  try {
    const panel = pagePanels.get(pageNumber);
    if (jump) panel?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    await renderNearbyPages(pageNumber);
    const page = await pdf.getPage(pageNumber);
    if (version !== renderVersion) return;
    if (!renderedPages.has(pageNumber)) await renderOnePage(pageNumber);
  } catch (err) {
    if (err?.name !== 'RenderingCancelledException') console.error('Page rendering failed', err);
  }
}

async function goToPage(next) {
  if (!pdf) return;
  const targetPage = Math.max(1, Math.min(pdf.numPages, Number(next) || 1));
  if (targetPage === pageNumber) return;
  pageTurnDirection = targetPage > pageNumber ? 'next' : 'previous';
  pageNumber = targetPage;
  await buildPageStack();
  await renderPage(true);
}

$('prevPage').addEventListener('click', () => goToPage(pageNumber - 1));
$('nextPage').addEventListener('click', () => goToPage(pageNumber + 1));
$('pageInput').addEventListener('change', () => goToPage($('pageInput').value));
$('pageInput').addEventListener('keydown', event => { if (event.key === 'Enter') { goToPage($('pageInput').value); $('pageInput').blur(); } });
function resetRenderedPages() {
  renderedPages.clear();
  pagePanels.forEach(panel => {
    const pageCanvas = panel.querySelector('canvas');
    pageCanvas.width = 0;
    pageCanvas.height = 0;
  });
  if (pdf) renderNearbyPages(pageNumber);
}
let swipeStart = null;
canvasArea.addEventListener('touchstart', event => {
  if (event.touches.length === 1) swipeStart = { x: event.touches[0].clientX, y: event.touches[0].clientY };
}, { passive: true });
canvasArea.addEventListener('touchend', event => {
  if (!swipeStart || !event.changedTouches.length) return;
  const dx = event.changedTouches[0].clientX - swipeStart.x;
  const dy = event.changedTouches[0].clientY - swipeStart.y;
  if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.25) goToPage(pageNumber + (dx < 0 ? 1 : -1));
  swipeStart = null;
}, { passive: true });

document.addEventListener('keydown', event => {
  if (event.target.matches('input')) return;
  if (event.key === 'ArrowRight' || event.key === 'PageDown') goToPage(pageNumber + 1);
  if (event.key === 'ArrowLeft' || event.key === 'PageUp') goToPage(pageNumber - 1);
});

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (pdf) { resetRenderedPages(); renderPage(); } }, 120);
});
