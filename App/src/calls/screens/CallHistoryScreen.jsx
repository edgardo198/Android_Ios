import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { FontAwesomeIcon } from '@fortawesome/react-native-fontawesome';
import { faPhone, faTrash, faVideo } from '@fortawesome/free-solid-svg-icons';
import api from '../../core/api';
import useGlobal from '../../core/global';
import WebBackButton from '../../common/WebBackButton';
import DeleteConfirmation from '../../common/DeleteConfirmation';
import { normalizeApiError } from '../../common/apiError';
import { callResultLabel, formatCallDate, formatCallDuration } from '../callPresentation';
import { useCalls } from '../CallsProvider';

export function CallHistoryRow({ item, onDelete, deleting = false }) {
  const peer = item.peer || (item.direction === 'incoming' ? item.caller : item.callee);
  const name = peer?.name || peer?.username || 'Contacto';
  const kind = item.kind === 'video' ? 'Videollamada' : 'Audio';
  const direction = item.direction === 'incoming' ? 'Entrante' : 'Saliente';
  const date = formatCallDate(item.endedAt || item.createdAt);
  const duration = formatCallDuration(item.durationSeconds);
  const result = callResultLabel(item.reason, item.direction, item.result);
  return (
    <View style={styles.row}>
      <View style={styles.icon}><FontAwesomeIcon icon={item.kind === 'video' ? faVideo : faPhone} size={21} color="#155EA0" /></View>
      <View style={styles.rowContent}>
        <Text style={styles.peer} numberOfLines={2}>{name}</Text>
        <Text style={styles.detail}>{kind} · {direction}</Text>
        <Text style={[styles.result, ['missed', 'rejected', 'connection_timeout', 'unavailable'].includes(item.reason) && styles.unanswered]}>{result}</Text>
        {date && <Text style={styles.date}>{date}</Text>}
        {duration && <Text style={styles.date}>Duración: {duration}</Text>}
      </View>
      {onDelete && <TouchableOpacity style={styles.deleteRow} disabled={deleting} onPress={() => onDelete(item)} accessibilityRole="button" accessibilityLabel={`Borrar llamada con ${name}`} accessibilityState={{ disabled: deleting }}>
        <FontAwesomeIcon icon={faTrash} size={17} color="#8B2424" />
      </TouchableOpacity>}
    </View>
  );
}

export default function CallHistoryScreen({ navigation }) {
  const authenticated = useGlobal((state) => state.authenticated);
  const { historyRevision } = useCalls();
  const [items, setItems] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [loading, setLoading] = useState(null);
  const [error, setError] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [deleteError, setDeleteError] = useState(null);
  const mounted = useRef(true);
  const focused = useRef(false);
  const generation = useRef(0);
  const request = useRef(null);
  const retry = useRef({ cursor: null, append: false });
  const deletion = useRef(null);
  const revision = useRef(historyRevision);
  const refreshAfterDelete = useRef(false);

  const invalidate = useCallback(() => {
    generation.current += 1;
    request.current?.controller.abort();
    request.current = null;
    deletion.current?.controller.abort();
    deletion.current = null;
  }, []);

  const loadPage = useCallback(async (cursor = null, append = false) => {
    const state = useGlobal.getState();
    if (!mounted.current || !focused.current || !state.authenticated || !state.user?.username || request.current) return false;
    const operation = { controller: new AbortController(), generation: generation.current, username: state.user.username };
    request.current = operation;
    retry.current = { cursor, append };
    setLoading(append ? 'more' : 'initial');
    setError(null);
    const current = () => mounted.current && focused.current && request.current === operation &&
      generation.current === operation.generation && useGlobal.getState().authenticated &&
      useGlobal.getState().user?.username === operation.username;
    try {
      const response = await api.get('/calls/history/', {
        params: { limit: 50, ...(cursor ? { cursor } : {}) }, signal: operation.controller.signal,
      });
      if (!current()) return false;
      const data = response.data;
      if (!Array.isArray(data?.results) || (data.nextCursor != null && typeof data.nextCursor !== 'string')) {
        throw new Error('Invalid call history response');
      }
      setItems((previous) => {
        const merged = new Map((append ? previous : []).map((item) => [String(item.id), item]));
        data.results.filter((item) => item && item.id != null).forEach((item) => merged.set(String(item.id), item));
        return [...merged.values()];
      });
      setNextCursor(data.nextCursor || null);
      return true;
    } catch (failure) {
      if (current()) setError(normalizeApiError(failure.response?.data, 'No se pudo cargar el historial. Revisa tu conexión e intenta nuevamente.'));
      return false;
    } finally {
      if (request.current === operation) {
        request.current = null;
        if (mounted.current) setLoading(null);
      }
    }
  }, []);

  const refresh = useCallback(() => {
    invalidate();
    setItems([]); setNextCursor(null); setError(null); setLoading(null);
    void loadPage();
  }, [invalidate, loadPage]);

  useEffect(() => {
    if (Object.is(revision.current, historyRevision)) return;
    revision.current = historyRevision;
    if (!focused.current) return;
    if (deletion.current) { refreshAfterDelete.current = true; return; }
    refresh();
  }, [historyRevision, refresh]);

  const openDelete = useCallback((item = null) => {
    const state = useGlobal.getState();
    if (!focused.current || !state.authenticated || deletion.current) return;
    setDeleteTarget({ id: item?.id || null, username: state.user?.username });
    setDeleteError(null);
  }, []);

  const deleteHistory = useCallback(async () => {
    const state = useGlobal.getState();
    if (!deleteTarget || deletion.current || !mounted.current || !focused.current ||
        !state.authenticated || state.user?.username !== deleteTarget.username) return false;
    invalidate();
    setLoading(null);
    const operation = { controller: new AbortController(), generation: generation.current, username: state.user.username };
    deletion.current = operation;
    setDeleting(deleteTarget.id || 'all');
    setDeleteError(null);
    const current = () => mounted.current && focused.current && deletion.current === operation &&
      generation.current === operation.generation && useGlobal.getState().authenticated &&
      useGlobal.getState().user?.username === operation.username;
    try {
      const url = deleteTarget.id ? `/calls/history/${encodeURIComponent(deleteTarget.id)}/` : '/calls/history/';
      const response = await api.delete(url, { signal: operation.controller.signal });
      if (!current()) return false;
      if (!Number.isSafeInteger(response.data?.deletedCount) ||
          (response.data.callIds !== null && !Array.isArray(response.data.callIds))) throw new Error('Invalid deletion response');
      setItems((previous) => response.data.callIds === null ? [] : previous.filter((item) => !response.data.callIds.includes(item.id)));
      setDeleteTarget(null);
      deletion.current = null;
      setDeleting(null);
      refreshAfterDelete.current = false;
      refresh();
      return true;
    } catch (failure) {
      if (current()) setDeleteError(normalizeApiError(failure.response?.data,
        'No se pudo confirmar el borrado. Revisa tu conexión e intenta nuevamente.'));
      return false;
    } finally {
      if (deletion.current === operation) {
        deletion.current = null;
        if (mounted.current) setDeleting(null);
        if (refreshAfterDelete.current && focused.current) {
          refreshAfterDelete.current = false;
          refresh();
        }
      }
    }
  }, [deleteTarget, invalidate, refresh]);

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = useGlobal.subscribe((next, previous) => {
      if (next.authenticated === previous.authenticated && next.user?.username === previous.user?.username) return;
      invalidate();
      setItems([]); setNextCursor(null); setError(null); setLoading(null);
      setDeleteTarget(null); setDeleting(null); setDeleteError(null); refreshAfterDelete.current = false;
      if (next.authenticated && focused.current) void loadPage();
    });
    return () => { mounted.current = false; focused.current = false; unsubscribe(); invalidate(); };
  }, [invalidate, loadPage]);

  useFocusEffect(useCallback(() => {
    focused.current = true;
    invalidate();
    setItems([]); setNextCursor(null); setError(null);
    void loadPage();
    return () => { focused.current = false; invalidate(); setDeleteTarget(null); setDeleting(null); setDeleteError(null); };
  }, [invalidate, loadPage]));

  const footer = (
    <View style={styles.footer}>
      {error && <Text style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="polite">{error}</Text>}
      {loading && <ActivityIndicator color="#155EA0" accessibilityLabel="Cargando historial de llamadas" />}
      {error ? <TouchableOpacity style={styles.button} disabled={!!loading} onPress={() => loadPage(retry.current.cursor, retry.current.append)} accessibilityRole="button" accessibilityLabel="Reintentar historial"><Text style={styles.buttonText}>Reintentar</Text></TouchableOpacity>
        : nextCursor && <TouchableOpacity style={styles.button} disabled={!!loading} onPress={() => loadPage(nextCursor, true)} accessibilityRole="button" accessibilityLabel="Cargar más llamadas" accessibilityState={{ disabled: !!loading }}><Text style={styles.buttonText}>Ver más llamadas</Text></TouchableOpacity>}
    </View>
  );
  return (
    <SafeAreaView style={styles.page}>
      <View style={styles.header}>
        <WebBackButton navigation={navigation} fallbackRoute="Home" />
        <Text style={styles.title} accessibilityRole="header">Historial de llamadas</Text>
        <TouchableOpacity style={styles.refresh} disabled={!!loading || !authenticated} onPress={() => loadPage()} accessibilityRole="button" accessibilityLabel="Actualizar historial" accessibilityState={{ disabled: !!loading || !authenticated }}><Text style={styles.refreshText}>Actualizar</Text></TouchableOpacity>
        <TouchableOpacity style={styles.clearAll} disabled={!!deleting || !authenticated || !items.length} onPress={() => openDelete()} accessibilityRole="button" accessibilityLabel="Borrar todo el historial de llamadas" accessibilityState={{ disabled: !!deleting || !authenticated || !items.length }}><Text style={styles.deleteText}>Borrar historial</Text></TouchableOpacity>
      </View>
      {!authenticated ? <Text style={styles.empty}>Inicia sesión para ver tu historial.</Text> : (
        <FlatList style={styles.list} contentContainerStyle={styles.content} data={items} keyExtractor={(item) => String(item.id)}
          renderItem={({ item }) => <CallHistoryRow item={item} onDelete={openDelete} deleting={!!deleting} />}
          ListEmptyComponent={!loading && !error ? <Text style={styles.empty}>Aún no tienes llamadas en tu historial.</Text> : null}
          ListFooterComponent={footer} />
      )}
      {deleteTarget && <DeleteConfirmation visible title={deleteTarget.id ? 'Borrar esta llamada' : 'Borrar historial de llamadas'}
        message={`${deleteTarget.id ? 'El registro de esta llamada' : 'Los registros de tus llamadas finalizadas'} se borrará${deleteTarget.id ? '' : 'n'} para ambos participantes. Las llamadas en curso no se interrumpen. Esta acción no se puede deshacer.`}
        busy={!!deleting} error={deleteError} onConfirm={deleteHistory} onCancel={() => { if (!deletion.current) { setDeleteTarget(null); setDeleteError(null); } }} />}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#F0F8FF' },
  header: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 16, gap: 12 },
  title: { fontSize: 25, color: '#163B5D', fontWeight: '700' },
  refresh: { minHeight: 44, alignSelf: 'flex-start', justifyContent: 'center' },
  refreshText: { color: '#155EA0', fontSize: 15, fontWeight: '600' },
  clearAll: { minHeight: 44, alignSelf: 'flex-start', justifyContent: 'center' },
  deleteText: { color: '#8B2424', fontSize: 15, fontWeight: '600' },
  list: { flex: 1, minHeight: 0 },
  content: { paddingHorizontal: 20, paddingBottom: 24, width: '100%', maxWidth: 720, alignSelf: 'center' },
  row: { flexDirection: 'row', backgroundColor: '#FFFFFF', padding: 16, borderRadius: 14, marginBottom: 12, gap: 14 },
  icon: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#EDF5FC', justifyContent: 'center', alignItems: 'center' },
  rowContent: { flex: 1, minWidth: 0, gap: 5 },
  deleteRow: { width: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-start' },
  peer: { color: '#163B5D', fontSize: 17, fontWeight: '600' },
  detail: { color: '#365C78', fontSize: 14, lineHeight: 20 },
  result: { color: '#365C78', fontSize: 14, fontWeight: '600' },
  unanswered: { color: '#8B2424' },
  date: { color: '#365C78', fontSize: 13, lineHeight: 19 },
  footer: { alignItems: 'center', gap: 14, paddingVertical: 12 },
  empty: { color: '#365C78', fontSize: 15, lineHeight: 22, textAlign: 'center', padding: 24 },
  error: { color: '#8B2424', backgroundColor: '#FFFFFF', padding: 14, borderRadius: 12, fontSize: 14, lineHeight: 21, alignSelf: 'stretch' },
  button: { minHeight: 48, padding: 14, borderRadius: 12, backgroundColor: '#155EA0', justifyContent: 'center', alignItems: 'center' },
  buttonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },
});
