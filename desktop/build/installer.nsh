; AnonChat: extra uninstaller step (electron-builder includes this file from build/).
;
; Uninstalling keeps your identity, contacts and messages unless you say otherwise, so a reinstall picks up where you left off.
; Everything lives in one folder, %APPDATA%\anonchat.
; Not asked during an update (the old version is uninstalled silently first) or a silent uninstall: those always keep the data.
; The question follows the installer's language ($LANGUAGE, a Windows language ID); Windows itself translates the Yes/No buttons.
; Saved as UTF-8 with a byte-order mark so the non-English text reaches the Unicode installer intact.

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ${IfNot} ${Silent}
      Push $R9
      StrCpy $R9 "Also delete your AnonChat identity, contacts and messages from this computer?$\r$\n$\r$\nChoose No to keep them for a later reinstall. Deleting can't be undone."
      ${If} $LANGUAGE = 1034
      ${OrIf} $LANGUAGE = 3082
        StrCpy $R9 "¿Eliminar también tu identidad, tus contactos y tus mensajes de AnonChat de este ordenador?$\r$\n$\r$\nElige No para conservarlos por si lo vuelves a instalar. La eliminación no se puede deshacer."
      ${ElseIf} $LANGUAGE = 1036
        StrCpy $R9 "Supprimer aussi votre identité, vos contacts et vos messages AnonChat de cet ordinateur ?$\r$\n$\r$\nChoisissez Non pour les conserver en vue d’une réinstallation. La suppression est irréversible."
      ${ElseIf} $LANGUAGE = 1040
        StrCpy $R9 "Eliminare anche identità, contatti e messaggi di AnonChat da questo computer?$\r$\n$\r$\nScegli No per conservarli per una futura reinstallazione. L’eliminazione non può essere annullata."
      ${ElseIf} $LANGUAGE = 1031
        StrCpy $R9 "Auch deine AnonChat-Identität, Kontakte und Nachrichten von diesem Computer löschen?$\r$\n$\r$\nWähle Nein, um sie für eine spätere Neuinstallation zu behalten. Das Löschen lässt sich nicht rückgängig machen."
      ${ElseIf} $LANGUAGE = 2070
      ${OrIf} $LANGUAGE = 1046
        StrCpy $R9 "Eliminar também a sua identidade, os contactos e as mensagens do AnonChat deste computador?$\r$\n$\r$\nEscolha Não para os manter para uma futura reinstalação. A eliminação não pode ser anulada."
      ${ElseIf} $LANGUAGE = 2052
        StrCpy $R9 "同时从这台电脑删除你的 AnonChat 身份、联系人和消息吗？$\r$\n$\r$\n选择“否”可保留它们，以便日后重新安装。删除后无法撤销。"
      ${ElseIf} $LANGUAGE = 1041
        StrCpy $R9 "このコンピューターから AnonChat の ID、連絡先、メッセージも削除しますか？$\r$\n$\r$\n再インストールに備えて残す場合は「いいえ」を選んでください。削除は元に戻せません。"
      ${ElseIf} $LANGUAGE = 1045
        StrCpy $R9 "Usunąć również tożsamość, kontakty i wiadomości AnonChat z tego komputera?$\r$\n$\r$\nWybierz Nie, aby je zachować na wypadek ponownej instalacji. Usunięcia nie da się cofnąć."
      ${EndIf}
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "$R9" /SD IDNO IDNO anonchat_keep_data
        RMDir /r "$APPDATA\anonchat"
      anonchat_keep_data:
      Pop $R9
    ${EndIf}
  ${endIf}
!macroend
