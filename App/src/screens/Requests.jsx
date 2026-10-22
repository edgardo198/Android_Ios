import { ActivityIndicator, FlatList, Text } from 'react-native';
import { faBell } from '@fortawesome/free-solid-svg-icons';
import useGlobal from '../core/global';
import Empty from '../common/Empty';
import { View } from 'react-native';
import Cell from '../common/Cell';
import Miniatura from '../common/Miniatura';
import { TouchableOpacity } from 'react-native-gesture-handler';
import { formatTime } from '../core/utils';

function RequestAccept({item}){
    const requestAccept = useGlobal(state => state.requestAccept)
    return (
        <TouchableOpacity style={{
            backgroundColor:'#202020',
            paddingHorizontal: 14,
            height: 36,
            borderRadius: 18,
            alignItems: 'center',
            justifyContent: 'center'
        }}
        onPress={() => requestAccept(item.sender.username)}
        >
            <Text style={{
                color: 'white',
                fontWeight:'bold'
            }}
            >
                Agregar
            </Text>
        </TouchableOpacity>
    )
}


function RequestRow({item}){
    const message = 'Responder solicitud'
    return(
        <Cell>
        <Miniatura 
            url={item.sender.miniatura} 
            size={76} 
        />
            <View
                style={{
                    flex: 1,
                    paddingHorizontal: 16,
                }}
            >
                <Text
                    style={{
                        fontWeight: 'bold',
                        color: '#202020',
                        marginBottom: 4,
                    }}
                >
                    {item.sender.name}
                </Text>
                <Text
                    style={{
                        color: '#202020',
                    }}
                >
                    {message} <Text style={{ color: '#909090', fontSize: 13 }}> { formatTime(item.created) } </Text>
                </Text>
            </View>
            <RequestAccept item={item}/>
        </Cell>
    )
}

function RequestScreen() {
    const requestList = useGlobal(state => state.requestList)

    if (requestList === null){
        return (
            <ActivityIndicator style={{ flex: 1 }} />
        )
    }

    if (requestList.length === 0) {
        return (
            <Empty icon={faBell} message="Sin Solicitudes" />
        );
    }
    
    return (
        <View style={{
            flex: 1
        }}
        >
            <FlatList
                data={requestList}
                renderItem={({ item })=>  (
                    <RequestRow item={item}/>
                )}
                keyExtractor={item => item.sender.username}
            />
        </View>
    );
}

export default RequestScreen;
